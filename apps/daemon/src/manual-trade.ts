/**
 * Manual equity orders from the research terminal.
 *
 * The web app authenticates the user and forwards the request over the
 * loopback control channel; this module is the only place the order meets the
 * user's broker credentials. Those are readable only while the user has an
 * unlocked trading session, so a locked user gets 423 and nothing else.
 *
 * Unlike the equities worker, a manual order is the user's own explicit
 * instruction, so it does not wait on EQUITY_TRADE_EXECUTION (that switch
 * gates automated strategies). It still passes three guards here:
 *
 *   - the ticket must parse (shared rules in @b1dz/core/terminal);
 *   - a sell can never exceed the shares held (no short selling from a ticket);
 *   - a LIVE order may not exceed TERMINAL_MAX_ORDER_USD (default $10,000),
 *     and an order that cannot be priced is refused rather than waved through.
 *
 * Everything else (buying power, market hours, pattern day trading) is the
 * broker's call, and its answer is passed back verbatim.
 */
import {
  DEFAULT_TERMINAL_MAX_ORDER_USD,
  describeOrder,
  estimateOrderUsd,
  parseManualOrder,
  type BrokerOrder,
  type BrokerOrderResult,
  type BrokerPosition,
  type MarketSession,
} from '@b1dz/core';
import { linkedBrokers, refreshOauthTokens, type LinkedBroker } from './brokers.js';
import { loadUserConfigState, type UserConfig, type UserConfigState } from './user-config.js';

export type ManualTradeAction = 'account' | 'order' | 'cancel' | 'confirm';

export interface ManualTradeResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ManualTradeDeps {
  loadState(userId: string): Promise<UserConfigState>;
  refreshTokens(userId: string, cfg: UserConfig): Promise<boolean>;
  brokers(cfg: UserConfig): LinkedBroker[];
  log?(line: string): void;
}

const defaultDeps: ManualTradeDeps = {
  loadState: loadUserConfigState,
  refreshTokens: refreshOauthTokens,
  brokers: linkedBrokers,
  log: (line) => console.log(line),
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
/** Broker errors are shown to the user: keep them short and single-line. */
const brief = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300);

interface Resolved {
  cfg: UserConfig;
  list: LinkedBroker[];
  broker: LinkedBroker;
}

function summary(list: LinkedBroker[]) {
  return list.map((b) => ({ id: b.id, label: b.label, paper: b.paper, fractional: b.supportsFractional }));
}

function maxOrderUsd(cfg: UserConfig): number {
  const raw = Number.parseFloat(cfg.getUserPlain('TERMINAL_MAX_ORDER_USD') ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TERMINAL_MAX_ORDER_USD;
}

export function createManualTrade(deps: ManualTradeDeps = defaultDeps) {
  async function resolve(userId: string, brokerId: string): Promise<Resolved | ManualTradeResult> {
    let state = await deps.loadState(userId);
    if (state.status === 'locked' || state.status === 'legacy') {
      return { status: 423, body: { locked: true, error: 'Trading is locked. Unlock it with your passphrase in Settings, then try again.' } };
    }
    if (await deps.refreshTokens(userId, state.config)) state = await deps.loadState(userId);
    const list = deps.brokers(state.config);
    if (!list.length) return { status: 409, body: { brokers: [], error: 'No broker is linked. Add Alpaca or moomoo in Settings, Plugins.' } };
    const want = brokerId || str(state.config.getUserPlain('TERMINAL_BROKER'));
    const broker = list.find((b) => b.id === want) ?? (brokerId ? undefined : list[0]);
    if (!broker) return { status: 404, body: { brokers: summary(list), error: `${brokerId} is not linked on this account` } };
    return { cfg: state.config, list, broker };
  }

  async function account(r: Resolved): Promise<ManualTradeResult> {
    const c = r.broker.connector;
    const [bp, pos, ord, ses] = await Promise.allSettled([
      c.buyingPowerUsd(),
      c.positions(),
      c.listOrders ? c.listOrders() : Promise.resolve<BrokerOrder[]>([]),
      c.session('SPY'),
    ]);
    const base = {
      brokers: summary(r.list),
      broker: r.broker.id,
      label: r.broker.label,
      paper: r.broker.paper,
      fractional: r.broker.supportsFractional,
      maxOrderUsd: r.broker.paper ? null : maxOrderUsd(r.cfg),
    };
    // Buying power is the call that proves the link works; without it the account is unusable.
    if (bp.status === 'rejected') return { status: 200, body: { ...base, error: brief(bp.reason) } };
    return {
      status: 200,
      body: {
        ...base,
        buyingPowerUsd: bp.value,
        positions: pos.status === 'fulfilled' ? pos.value.filter((p: BrokerPosition) => p.qty !== 0) : [],
        orders: ord.status === 'fulfilled' ? ord.value.slice(0, 50) : [],
        session: ses.status === 'fulfilled' ? (ses.value as MarketSession).status : null,
        ordersSupported: !!c.listOrders,
        ...(pos.status === 'rejected' ? { positionsError: brief(pos.reason) } : {}),
      },
    };
  }

  function placed(r: Resolved, result: BrokerOrderResult): ManualTradeResult {
    const body = { broker: r.broker.id, paper: r.broker.paper, result };
    if (result.ok || result.needsConfirm) return { status: 200, body };
    return { status: 422, body: { ...body, error: result.message } };
  }

  async function order(userId: string, r: Resolved, input: Record<string, unknown>): Promise<ManualTradeResult> {
    const parsed = parseManualOrder(input);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
    const o = parsed.order;
    const c = r.broker.connector;

    if (!r.broker.supportsFractional && o.qty != null && !Number.isInteger(o.qty)) {
      return { status: 422, body: { error: `${r.broker.label} takes whole shares only` } };
    }

    if (o.side === 'sell') {
      let held: number;
      try {
        held = (await c.positions()).find((p) => p.symbol.toUpperCase() === o.symbol)?.qty ?? 0;
      } catch (e) {
        return { status: 502, body: { error: `could not read your ${r.broker.label} positions: ${brief(e)}` } };
      }
      if (held <= 0) return { status: 422, body: { error: `You hold no ${o.symbol} at ${r.broker.label}. Short selling is not available here.` } };
      if (o.qty != null && o.qty > held + 1e-9) {
        return { status: 422, body: { error: `You hold ${held} ${o.symbol}; this would sell ${o.qty}. Short selling is not available here.` } };
      }
    }

    if (!r.broker.paper) {
      const cap = maxOrderUsd(r.cfg);
      let price = o.limitPrice ?? 0;
      if (o.notionalUsd == null && !price) {
        try {
          const q = await c.quote(o.symbol);
          price = q.last || q.ask || q.bid || 0;
        } catch {
          price = 0;
        }
      }
      const usd = estimateOrderUsd(o, price);
      if (!usd) return { status: 422, body: { error: `No price for ${o.symbol} right now, so the order size cannot be checked. Use a limit order.` } };
      if (usd > cap) {
        return {
          status: 422,
          body: { error: `About $${Math.round(usd).toLocaleString('en-US')} is over your $${cap.toLocaleString('en-US')} limit for one live order. Raise it in Settings (TERMINAL_MAX_ORDER_USD) or send a smaller order.` },
        };
      }
    }

    const result = await c.placeOrder(o);
    deps.log?.(
      `[manual-trade] user=${userId.slice(0, 8)} broker=${r.broker.id} ${r.broker.paper ? 'paper' : 'LIVE'} "${describeOrder(o)}" -> ${result.ok ? `ok ${result.orderId ?? ''}` : result.needsConfirm ? 'needs-confirm' : `refused: ${brief(result.message)}`}`,
    );
    return placed(r, result);
  }

  return async function manualTrade(action: ManualTradeAction, userId: string, input: Record<string, unknown>): Promise<ManualTradeResult> {
    try {
      const r = await resolve(userId, str(input.broker).toLowerCase());
      if ('status' in r) {
        // Nothing linked is a normal state for the account view, not an error.
        if (action === 'account' && r.status === 409) return { status: 200, body: { brokers: [] } };
        return r;
      }
      if (action === 'account') return await account(r);
      if (action === 'order') return await order(userId, r, input);
      if (action === 'cancel') {
        const orderId = str(input.orderId);
        if (!orderId || orderId.length > 128) return { status: 400, body: { error: 'orderId required' } };
        const result = await r.broker.connector.cancelOrder(orderId);
        deps.log?.(`[manual-trade] user=${userId.slice(0, 8)} broker=${r.broker.id} cancel ${orderId} -> ${result.ok ? 'ok' : `refused: ${brief(result.message)}`}`);
        return result.ok ? { status: 200, body: { broker: r.broker.id, result } } : { status: 422, body: { broker: r.broker.id, result, error: result.message } };
      }
      const confirmId = str(input.confirmId);
      if (!confirmId || confirmId.length > 256) return { status: 400, body: { error: 'confirmId required' } };
      if (!r.broker.connector.confirmOrder) return { status: 400, body: { error: `${r.broker.label} has no order confirmation step` } };
      const result = await r.broker.connector.confirmOrder(confirmId);
      deps.log?.(`[manual-trade] user=${userId.slice(0, 8)} broker=${r.broker.id} ${r.broker.paper ? 'paper' : 'LIVE'} confirm -> ${result.ok ? `ok ${result.orderId ?? ''}` : `refused: ${brief(result.message)}`}`);
      return placed(r, result);
    } catch (e) {
      return { status: 502, body: { error: brief(e) } };
    }
  };
}

export type ManualTrade = ReturnType<typeof createManualTrade>;
