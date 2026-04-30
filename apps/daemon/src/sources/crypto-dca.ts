/**
 * DCA (Dollar-Cost Averaging) worker — passive accumulation across all
 * four CEXes.
 *
 * Every tick:
 *   1. Load config from env (DCA_* vars).
 *   2. Read current balances per exchange — compute account equity as
 *      total quote-asset USD across configured exchanges.
 *   3. Read persisted lastBuyAt map from source-state/crypto-dca.
 *   4. Let decideDcaBuys() produce the buy list.
 *   5. Per buy: fetch current ask via the exchange feed, convert
 *      usdAmount → base-coin quantity, place an IOC limit buy at
 *      ask × 1.02 (market-like with slippage ceiling — same pattern as
 *      the momentum strategy).
 *   6. On success, update lastBuyAt[exchange:coin] = Date.now().
 *   7. Persist lastBuyAt back to source-state.
 *
 * Capital isolation: DCA doesn't try to reserve a bucket. The existing
 * momentum/arb sizer caps at MAX_POSITION_USD=$100 and the DCA per-buy
 * usdAmount is small (e.g. $8.33 on $1000 equity at 10%/4 exchanges/3
 * coins). As long as the exchange has enough free quote, both systems
 * coexist.
 */

import type { SourceWorker, UserContext } from '../types.js';
import {
  KrakenFeed, CoinbaseFeed, BinanceUsFeed, GeminiFeed,
  placeOrder as placeKrakenOrder,
  placeBinanceOrder,
  placeCoinbaseOrder,
  placeGeminiOrder,
  getBalance as getKrakenBalance,
  getBinanceBalance,
  getCoinbaseBalance,
  getGeminiBalance,
  normalizePair,
} from '@b1dz/source-crypto-arb';
import {
  dcaConfigFromEnv,
  decideDcaBuys,
  type DcaBuy,
} from '@b1dz/source-crypto-trade';
import { getB1dzVersion } from '@b1dz/core';
import { runnerStorageFor } from '../runner-storage.js';
import { logActivity, logRaw, getActivityLog, getRawLog } from './activity-log.js';

const POLL_INTERVAL_MS = 60_000; // planner ticks every 60s — interval/interval gate inside decideDcaBuys handles pacing

const krakenFeed = new KrakenFeed();
const coinbaseFeed = new CoinbaseFeed();
const binanceFeed = new BinanceUsFeed();
const geminiFeed = new GeminiFeed();
const FEEDS: Record<string, { snapshot: (pair: string) => Promise<{ bid: number; ask: number } | null> }> = {
  kraken: krakenFeed,
  coinbase: coinbaseFeed,
  'binance-us': binanceFeed,
  gemini: geminiFeed,
};

// ── State persistence ─────────────────────────────────────────
// lastBuyAt is a Map<`${exchange}:${coin}`, epochMs>. Persisted as a plain
// object in source-state so it survives daemon restarts.

interface DcaPayload {
  enabled?: boolean;
  lastBuyAt?: Record<string, number>;
  recentBuys?: { at: string; exchange: string; coin: string; usd: number; orderId: string }[];
  activityLog?: ReturnType<typeof getActivityLog>;
  rawLog?: ReturnType<typeof getRawLog>;
  daemon?: { lastTickAt: string; worker: string; status: string; version?: string };
}

async function fetchEquityUsd(): Promise<number> {
  const tasks = [
    getKrakenBalance().then((b) => parseFloat(b.ZUSD ?? b.USD ?? '0')).catch(() => 0),
    getCoinbaseBalance().then((b) => parseFloat(b.USD ?? '0')).catch(() => 0),
    getBinanceBalance().then((b) => parseFloat(b.USD ?? '0')).catch(() => 0),
    getGeminiBalance().then((b) => parseFloat(b.USD ?? '0')).catch(() => 0),
  ];
  const results = await Promise.all(tasks);
  let equity = 0;
  for (const v of results) if (Number.isFinite(v) && v > 0) equity += v;
  return equity;
}

// Per-exchange available USD — used to size buys against each exchange's
// own balance rather than slicing total equity evenly.
async function fetchPerExchangeUsd(): Promise<Record<string, number>> {
  const [kraken, coinbase, binance, gemini] = await Promise.all([
    getKrakenBalance().then((b) => parseFloat(b.ZUSD ?? b.USD ?? '0')).catch(() => 0),
    getCoinbaseBalance().then((b) => parseFloat(b.USD ?? '0')).catch(() => 0),
    getBinanceBalance().then((b) => parseFloat(b.USD ?? '0')).catch(() => 0),
    getGeminiBalance().then((b) => parseFloat(b.USD ?? '0')).catch(() => 0),
  ]);
  return { kraken, coinbase, 'binance-us': binance, gemini };
}

async function executeDcaBuy(buy: DcaBuy): Promise<{ ok: true; orderId: string; filled: number } | { ok: false; message: string }> {
  const feed = FEEDS[buy.exchange];
  if (!feed) return { ok: false, message: `no feed for ${buy.exchange}` };

  const pair = `${buy.coin}-USD`;
  const snap = await feed.snapshot(pair);
  if (!snap || !(snap.ask > 0)) return { ok: false, message: `no ask for ${buy.exchange}:${pair}` };

  // IOC limit 2% above ask = market-like with a slippage ceiling.
  const limitPrice = snap.ask * 1.02;
  const quantity = buy.usdAmount / limitPrice;
  if (!(quantity > 0)) return { ok: false, message: `zero quantity for $${buy.usdAmount}` };

  try {
    if (buy.exchange === 'kraken') {
      const krakenPair = pair.replace('-', '').replace('BTC', 'XBT');
      const result = await placeKrakenOrder({
        pair: krakenPair,
        type: 'buy',
        ordertype: 'limit',
        volume: quantity.toFixed(8),
        price: limitPrice.toFixed(2),
        timeinforce: 'IOC',
      });
      return { ok: true, orderId: result.txid?.[0] ?? result.descr?.order ?? 'unknown', filled: quantity };
    }
    if (buy.exchange === 'coinbase') {
      const result = await placeCoinbaseOrder({
        productId: pair,
        side: 'BUY',
        size: quantity.toFixed(8),
        limitPrice: limitPrice.toFixed(2),
        ioc: true,
      });
      return { ok: true, orderId: result.order_id ?? 'unknown', filled: quantity };
    }
    if (buy.exchange === 'binance-us') {
      const symbol = pair.replace('-', '');
      const result = await placeBinanceOrder({
        symbol,
        side: 'BUY',
        type: 'LIMIT',
        quantity: quantity.toFixed(8),
        price: limitPrice.toFixed(2),
        timeInForce: 'IOC',
      });
      return { ok: true, orderId: String(result.orderId ?? 'unknown'), filled: parseFloat(result.executedQty ?? '0') };
    }
    if (buy.exchange === 'gemini') {
      const symbol = normalizePair(pair, 'gemini');
      const result = await placeGeminiOrder({
        symbol,
        side: 'buy',
        amount: quantity.toFixed(8),
        price: limitPrice.toFixed(2),
        options: ['immediate-or-cancel'],
      });
      return { ok: true, orderId: result.order_id ?? 'unknown', filled: parseFloat(result.executed_amount ?? '0') };
    }
    return { ok: false, message: `unsupported exchange ${buy.exchange}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ── Worker ─────────────────────────────────────────────────────

export const cryptoDcaWorker: SourceWorker = {
  id: 'crypto-dca',
  pollIntervalMs: POLL_INTERVAL_MS,
  hasCredentials(payload) {
    return !!(payload?.enabled ?? true);
  },
  async tick(ctx: UserContext) {
    const storage = runnerStorageFor(ctx);
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logRaw(args.map(String).join(' '), 'crypto-dca');
    console.error = (...args: unknown[]) => logRaw(args.map(String).join(' '), 'crypto-dca');

    try {
      const config = dcaConfigFromEnv();
      const payload = (ctx.payload as DcaPayload | undefined) ?? {};
      const lastBuyAtObj = payload.lastBuyAt ?? {};
      const lastBuyAt = new Map<string, number>(Object.entries(lastBuyAtObj));
      const recentBuys = payload.recentBuys ?? [];

      if (!config.enabled) {
        await ctx.savePayload({
          ...payload,
          enabled: false,
          lastBuyAt: lastBuyAtObj,
          daemon: { lastTickAt: new Date().toISOString(), worker: 'crypto-dca', status: 'disabled', version: getB1dzVersion() },
        });
        return;
      }

      const [equityUsd, perExchangeUsd] = await Promise.all([fetchEquityUsd(), fetchPerExchangeUsd()]);
      const currentHoldings = new Map<string, Set<string>>();

      // Size each exchange's buys against its own available USD (not a
      // pro-rata slice of total equity). This way an exchange with $70
      // gets $70 worth of buys; one with $0.01 skips below-minimum checks.
      // DCA_TOTAL_ALLOCATION_PCT still acts as a cap — default 80% so we
      // keep a small reserve and don't overdraft on fees.
      const allocPct = Math.min(100, Math.max(0, config.totalAllocationPct > 10
        ? config.totalAllocationPct  // user overrode via env — respect it
        : 80));                       // default: use 80% of each exchange's USD
      const now = Date.now();
      const buys: ReturnType<typeof decideDcaBuys> = [];
      for (const exchange of config.exchanges) {
        const available = perExchangeUsd[exchange] ?? 0;
        if (!(available > 0)) continue;
        // Feed the planner one exchange at a time with that exchange's own USD.
        const perBuyUsd = available * (allocPct / 100) / config.maxCoins;
        if (!(perBuyUsd > 0)) continue;
        const exchangeBuys = decideDcaBuys({
          config: { ...config, exchanges: [exchange], totalAllocationPct: 100 },
          now,
          equityUsd: available * config.maxCoins, // planner divides by maxCoins internally
          currentHoldings,
          lastBuyAt,
          isEligible: () => true,
        }).map((b) => ({ ...b, usdAmount: perBuyUsd }));
        buys.push(...exchangeBuys);
      }

      if (buys.length === 0) {
        await ctx.savePayload({
          ...payload,
          enabled: true,
          lastBuyAt: lastBuyAtObj,
          recentBuys,
          activityLog: getActivityLog('crypto-dca'),
          rawLog: getRawLog('crypto-dca'),
          daemon: { lastTickAt: new Date().toISOString(), worker: 'crypto-dca', status: 'idle', version: getB1dzVersion() },
        });
        return;
      }

      const totalBuyUsd = buys.reduce((s, b) => s + b.usdAmount, 0);
      logActivity(`[dca] planning ${buys.length} buy(s) — equity $${equityUsd.toFixed(2)}, total $${totalBuyUsd.toFixed(2)}, per-buy ~$${buys[0]?.usdAmount.toFixed(2) ?? 0}`, 'crypto-dca');

      for (const buy of buys) {
        const res = await executeDcaBuy(buy);
        if (res.ok) {
          const key = `${buy.exchange}:${buy.coin}`;
          lastBuyAtObj[key] = Date.now();
          recentBuys.push({
            at: new Date().toISOString(),
            exchange: buy.exchange,
            coin: buy.coin,
            usd: buy.usdAmount,
            orderId: res.orderId,
          });
          while (recentBuys.length > 50) recentBuys.shift();
          logActivity(`[dca] ✓ ${buy.exchange} ${buy.coin} $${buy.usdAmount.toFixed(2)} filled=${res.filled.toFixed(8)} order=${res.orderId}`, 'crypto-dca');
        } else {
          logActivity(`[dca] ✗ ${buy.exchange} ${buy.coin} $${buy.usdAmount.toFixed(2)} failed: ${res.message.slice(0, 120)}`, 'crypto-dca');
        }
      }

      await ctx.savePayload({
        ...payload,
        enabled: true,
        lastBuyAt: lastBuyAtObj,
        recentBuys,
        activityLog: getActivityLog('crypto-dca'),
        rawLog: getRawLog('crypto-dca'),
        daemon: { lastTickAt: new Date().toISOString(), worker: 'crypto-dca', status: 'running', version: getB1dzVersion() },
      });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  },
};
