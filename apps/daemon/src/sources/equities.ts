/**
 * Equities worker (M2 — execution).
 *
 * Per tick, for each watchlist symbol on the user's primary broker:
 *   1. quote → build an equity MarketSnapshot (session/halt-aware);
 *   2. accumulate per-symbol price history in source_state;
 *   3. run the deterministic StrategyPlugins → pick the strongest signal;
 *   4. hand (signal, session, account, position, risk config) to the equity
 *      engine, which owns ALL risk gating (session, PDT, buying-power sizing,
 *      overnight, halt, fractional) — see @b1dz/equity-engine;
 *   5. submit the resulting order when execution is permitted.
 *
 * Execution rule: a *paper* broker always executes (it's fake money, the point
 * of paper mode). A *live* broker executes only when EQUITY_TRADE_EXECUTION is
 * on — mirroring DEX_TRADE_EXECUTION. Strategies stay signals-only; they never
 * see the broker.
 *
 * Credentials come from user_settings via loadUserConfig (decrypted server-side)
 * and never live as plaintext globals.
 */
import type { SourceWorker, UserContext } from '../types.js';
import { createAlpacaConnector } from '@b1dz/source-alpaca';
import { createIbkrConnector } from '@b1dz/source-ibkr';
import { STRATEGY_PLUGINS } from '@b1dz/source-strategies';
import {
  decideEquityOrder,
  countRecentDayTrades,
  type EquityRiskConfig,
} from '@b1dz/equity-engine';
import {
  getB1dzVersion,
  etParts,
  type BrokerConnectorPlugin,
  type MarketSnapshot,
  type Signal,
} from '@b1dz/core';
import { loadUserConfig, type UserConfig } from '../user-config.js';

const POLL_INTERVAL_MS = 30_000;
const HISTORY_CAP = 120;

interface PrimaryBroker { id: string; connector: BrokerConnectorPlugin; paper: boolean; supportsFractional: boolean; }

/** Pick the broker to trade through: Alpaca (API-key, paper-friendly) if
 *  configured, else IBKR if a gateway is set. */
function primaryBroker(cfg: UserConfig): PrimaryBroker | null {
  const key = cfg.getSecret('ALPACA_API_KEY_ID');
  const secret = cfg.getSecret('ALPACA_API_SECRET_KEY');
  if (key && secret) {
    const paper = cfg.getBool('ALPACA_PAPER', true) ?? true;
    return {
      id: 'alpaca',
      paper,
      supportsFractional: true,
      connector: createAlpacaConnector({ keyId: key, secretKey: secret, paper, feed: (cfg.getPlain('ALPACA_FEED') as 'iex' | 'sip' | undefined) ?? 'iex' }),
    };
  }
  const base = cfg.getPlain('IBKR_BASE_URL');
  if (base) {
    return {
      id: 'ibkr',
      paper: false,
      supportsFractional: true,
      connector: createIbkrConnector({ baseUrl: base, accountId: cfg.getPlain('IBKR_ACCOUNT_ID'), accessToken: cfg.getSecret('IBKR_ACCESS_TOKEN') }),
    };
  }
  return null;
}

function riskConfig(cfg: UserConfig): EquityRiskConfig {
  return {
    perTradeUsd: cfg.getNumber('EQUITY_PER_TRADE_USD', 500)!,
    maxPositionUsd: cfg.getNumber('EQUITY_MAX_POSITION_USD', 2_000)!,
    allowOvernight: cfg.getBool('ALLOW_OVERNIGHT', false) ?? false,
    maxOvernightUsd: cfg.getNumber('MAX_OVERNIGHT_USD', 0)!,
    extendedHours: cfg.getBool('EQUITY_EXTENDED_HOURS', false) ?? false,
    minSignalStrength: cfg.getNumber('EQUITY_MIN_SIGNAL', 0.1)!,
    pdtGuardEnabled: cfg.getBool('EQUITY_PDT_GUARD', true) ?? true,
    closeBufferMin: cfg.getNumber('EQUITY_CLOSE_BUFFER_MIN', 15)!,
  };
}

function watchlist(cfg: UserConfig): string[] {
  return (cfg.getPlain('EQUITY_WATCHLIST', 'SPY,AAPL,MSFT') ?? '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

interface SymbolState { history: { bid: number; ask: number; ts: number }[]; openedEtDate?: string; }
interface RecentOrder { at: string; symbol: string; side: string; status: string; executed: boolean; note: string; }

/** Pick the strongest signal across all strategies for one snapshot. */
function strongestSignal(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null {
  let best: Signal | null = null;
  for (const s of STRATEGY_PLUGINS) {
    const sig = s.evaluate(snap, history);
    if (sig && (!best || sig.strength > best.strength)) best = sig;
  }
  return best;
}

export const equitiesWorker: SourceWorker = {
  id: 'equities',
  pollIntervalMs: POLL_INTERVAL_MS,
  hasCredentials(payload) {
    return !!payload?.enabled;
  },
  async tick(ctx: UserContext) {
    const cfg = await loadUserConfig(ctx.userId);
    const now = new Date();
    const nowIso = now.toISOString();
    const version = getB1dzVersion();
    const payload = ctx.payload as Record<string, unknown>;

    if (cfg.getBool('EQUITIES_ENABLED', false) !== true) {
      await ctx.savePayload({ ...payload, enabled: false, daemon: { lastTickAt: nowIso, worker: 'equities', status: 'disabled', version } });
      return;
    }

    const broker = primaryBroker(cfg);
    if (!broker) {
      await ctx.savePayload({ ...payload, enabled: true, daemon: { lastTickAt: nowIso, worker: 'equities', status: 'idle', version }, note: 'no broker configured' });
      return;
    }

    const risk = riskConfig(cfg);
    const symbols = watchlist(cfg);
    const executionEnabled = cfg.getBool('EQUITY_TRADE_EXECUTION', false) ?? false;
    const equityUsd = cfg.getNumber('EQUITY_ACCOUNT_EQUITY_USD'); // optional; enables PDT guard
    const shouldExecute = broker.paper || executionEnabled;
    const etDate = etParts(now).yyyymmdd;

    const watch = (payload.watch as Record<string, SymbolState>) ?? {};
    const dayTrades = (payload.dayTrades as number[]) ?? [];
    const recentOrders = (payload.recentOrders as RecentOrder[]) ?? [];

    let buyingPowerUsd = 0;
    let positionsBySymbol = new Map<string, number>();
    try {
      const [bp, positions] = await Promise.all([broker.connector.buyingPowerUsd(), broker.connector.positions()]);
      buyingPowerUsd = bp;
      positionsBySymbol = new Map(positions.map((p) => [p.symbol.toUpperCase(), p.qty]));
    } catch (err) {
      await ctx.savePayload({ ...payload, enabled: true, brokers: { [broker.id]: { linked: false, reason: (err as Error).message.slice(0, 200) } }, daemon: { lastTickAt: nowIso, worker: 'equities', status: 'error', version } });
      return;
    }

    for (const symbol of symbols) {
      try {
        const [quote, session] = await Promise.all([broker.connector.quote(symbol), broker.connector.session(symbol)]);
        const st = watch[symbol] ?? { history: [] };
        st.history.push({ bid: quote.bid, ask: quote.ask, ts: quote.ts || now.getTime() });
        if (st.history.length > HISTORY_CAP) st.history = st.history.slice(-HISTORY_CAP);
        watch[symbol] = st;

        const toSnap = (h: { bid: number; ask: number; ts: number }): MarketSnapshot => ({
          exchange: broker.id, pair: symbol, bid: h.bid, ask: h.ask, bidSize: 0, askSize: 0, ts: h.ts,
          assetClass: 'equity', session, currency: 'USD', haltState: 'none',
        });
        const snaps = st.history.map(toSnap);
        const snap = snaps.at(-1)!;
        const signal = strongestSignal(snap, snaps.slice(0, -1));
        if (!signal) continue;

        const qty = positionsBySymbol.get(symbol) ?? 0;
        const decision = decideEquityOrder({
          signal, symbol, session, haltState: 'none', lastPrice: quote.last || (quote.bid + quote.ask) / 2,
          account: { buyingPowerUsd, equityUsd, recentDayTrades: countRecentDayTrades(dayTrades, now.getTime()) },
          position: { qty, openedToday: st.openedEtDate === etDate },
          config: risk, supportsFractional: broker.supportsFractional, now,
        });

        if (decision.action === 'skip') continue;

        if (!shouldExecute) {
          recentOrders.push({ at: nowIso, symbol, side: decision.order.side, status: 'gated', executed: false, note: `${decision.reason} — live execution off (EQUITY_TRADE_EXECUTION)` });
          continue;
        }

        const result = await broker.connector.placeOrder(decision.order);
        recentOrders.push({ at: nowIso, symbol, side: decision.order.side, status: result.status ?? (result.ok ? 'accepted' : 'failed'), executed: result.ok, note: result.ok ? decision.reason : result.message.slice(0, 160) });

        if (result.ok) {
          if (decision.order.side === 'buy' && qty <= 0) {
            st.openedEtDate = etDate; // opened a new position today
          } else if (decision.order.side === 'sell') {
            if (st.openedEtDate === etDate) dayTrades.push(now.getTime()); // round-trip same day = day trade
            st.openedEtDate = undefined;
          }
        }
      } catch (err) {
        recentOrders.push({ at: nowIso, symbol, side: '-', status: 'error', executed: false, note: (err as Error).message.slice(0, 160) });
      }
    }

    while (recentOrders.length > 50) recentOrders.shift();
    const prunedDayTrades = dayTrades.filter((t) => t >= now.getTime() - 6 * 24 * 60 * 60 * 1000);

    await ctx.savePayload({
      ...payload,
      enabled: true,
      broker: broker.id,
      paper: broker.paper,
      executionEnabled,
      shouldExecute,
      buyingPowerUsd,
      watchlist: symbols,
      watch,
      dayTrades: prunedDayTrades,
      recentDayTrades: countRecentDayTrades(prunedDayTrades, now.getTime()),
      recentOrders,
      daemon: { lastTickAt: nowIso, worker: 'equities', status: 'running', version },
    });
  },
};
