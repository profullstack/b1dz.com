import type { SourceWorker, UserContext } from '../types.js';
import {
  cryptoArbSource,
  evaluateArbStrategies,
  KrakenFeed, BinanceUsFeed, CoinbaseFeed,
  getBalance, getBinanceBalance, getCoinbaseBalance, getCoinbaseAuthDebug,
  getTradeHistory, getOpenOrders,
  getActivePairs,
  subscribeWs, wsCacheSize, setWsLogger,
} from '@b1dz/source-crypto-arb';
import { AlertBus, getB1dzVersion } from '@b1dz/core';
import { runnerStorageFor } from '../runner-storage.js';
import { logActivity, logRaw, getActivityLog, getRawLog } from './activity-log.js';
import type { MarketSnapshot } from '@b1dz/core';

const FEEDS = [new KrakenFeed(), new BinanceUsFeed(), new CoinbaseFeed()];

// Private API state — refreshed periodically, but never allowed to linger
// invisibly after a failed fetch.
let cachedKrakenBalance: Record<string, string> = {};
let cachedBinanceBalance: Record<string, string> = {};
let cachedCoinbaseBalance: Record<string, string> = {};
let cachedRecentTrades: unknown[] = [];
let cachedOpenOrders: unknown[] = [];
let lastPrivateFetch = 0;
const PRIVATE_FETCH_INTERVAL = 60_000; // 60s — balances/trades/orders
const KRAKEN_LOCKOUT_BACKOFF_MS = 15 * 60_000;
const KRAKEN_LOCKOUT_BACKOFF_MAX_MS = 60 * 60_000;
let krakenLockoutBackoffMs = KRAKEN_LOCKOUT_BACKOFF_MS;

const krakenNameMap: Record<string, string> = { XXBT: 'BTC', XETH: 'ETH', XXDG: 'DOGE', XZEC: 'ZEC', XXRP: 'XRP', XXLM: 'XLM', XXMR: 'XMR' };
const stableSet = new Set(['ZUSD', 'USD', 'USDC', 'USDT']);
let tickCount = 0;
let wsInitialized = false;

export const cryptoArbWorker: SourceWorker = {
  id: 'crypto-arb',
  pollIntervalMs: 2000,
  hasCredentials(payload) {
    return !!(payload?.enabled);
  },
  async tick(ctx: UserContext) {
    const storage = runnerStorageFor(ctx);
    const alerts = new AlertBus();
    const sourceCtx = { storage, alerts, state: { ...ctx.payload } };
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      logRaw(args.map(String).join(' '), 'crypto-arb');
    };
    console.error = (...args: unknown[]) => {
      logRaw(args.map(String).join(' '), 'crypto-arb');
    };

    try {
      // ── Fetch balances + trade history every 60s (private API, rate limited) ──
      if (Date.now() - lastPrivateFetch > PRIVATE_FETCH_INTERVAL) {
      lastPrivateFetch = Date.now();
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      try {
        cachedKrakenBalance = await getBalance();
        krakenLockoutBackoffMs = KRAKEN_LOCKOUT_BACKOFF_MS;
        logRaw(`[kraken] balance: ${Object.entries(cachedKrakenBalance).filter(([, v]) => parseFloat(v) > 0.0001).map(([k, v]) => `${k}=${v}`).join(' ')}`, 'crypto-arb');
        await wait(2000);
        const th = await getTradeHistory();
        cachedRecentTrades = Object.values(th).sort((a, b) => b.time - a.time).slice(0, 20);
        await wait(2000);
        const oo = await getOpenOrders();
        cachedOpenOrders = Object.entries(oo).map(([id, o]) => ({ id, ...o }));
      } catch (e) {
        cachedKrakenBalance = {};
        cachedRecentTrades = [];
        cachedOpenOrders = [];
        const msg = (e as Error).message;
        if (msg.includes('Rate limit') || msg.includes('Temporary lockout')) {
          const isLockout = msg.includes('Temporary lockout');
          const backoffMs = isLockout ? krakenLockoutBackoffMs : 60_000;
          logRaw(`[kraken] ✗ Rate limited, backing off ${Math.round(backoffMs / 1000)}s`, 'crypto-arb');
          lastPrivateFetch = Date.now() + backoffMs;
          if (isLockout) {
            krakenLockoutBackoffMs = Math.min(krakenLockoutBackoffMs * 2, KRAKEN_LOCKOUT_BACKOFF_MAX_MS);
          }
        } else {
          logRaw(`[kraken] ✗ Unable to connect: ${msg}`, 'crypto-arb');
        }
      }
      try {
        cachedBinanceBalance = await getBinanceBalance();
        logRaw(`[binance] balance: ${Object.entries(cachedBinanceBalance).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)'}`, 'crypto-arb');
      } catch (e) {
        cachedBinanceBalance = {};
        logRaw(`[binance] ✗ Unable to connect: ${(e as Error).message}`, 'crypto-arb');
      }
      try {
        const coinbaseAuth = getCoinbaseAuthDebug();
        if (!coinbaseAuth.hasKeyName || !coinbaseAuth.keyNameLooksValid || !coinbaseAuth.hasPem) {
          logRaw(`[coinbase] auth debug: hasKeyName=${coinbaseAuth.hasKeyName} keyNameLooksValid=${coinbaseAuth.keyNameLooksValid} hasPem=${coinbaseAuth.hasPem}`, 'crypto-arb');
        }
        cachedCoinbaseBalance = await getCoinbaseBalance();
        logRaw(`[coinbase] balance: ${Object.entries(cachedCoinbaseBalance).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)'}`, 'crypto-arb');
      } catch (e) {
        cachedCoinbaseBalance = {};
        const err = e as Error & { cause?: Error };
        const detail = err.cause ? ` (${err.cause.message})` : '';
        logRaw(`[coinbase] ✗ Unable to connect: ${err.message}${detail}`, 'crypto-arb');
      }
      }

      // ── Initialize WebSocket feeds on first tick ──
      if (!wsInitialized) {
        wsInitialized = true;
        setWsLogger((msg) => logRaw(msg, 'crypto-arb'));
        const discoveredPairs = await getActivePairs();
        subscribeWs(discoveredPairs);
        logRaw(`[ws] subscribed to ${discoveredPairs.length} pairs across 3 exchanges`, 'crypto-arb');
      }

      // ── Fetch prices every tick (WS cache → instant, REST fallback) ──
      const pairsToFetch = new Set(['BTC-USD', 'ETH-USD', 'SOL-USD']);
      for (const [k, v] of Object.entries(cachedKrakenBalance)) {
        if (parseFloat(v) > 0.0001 && !stableSet.has(k)) pairsToFetch.add(`${krakenNameMap[k] ?? k}-USD`);
      }
      for (const [k, v] of Object.entries(cachedCoinbaseBalance)) {
        if (parseFloat(v) > 0.0001 && !stableSet.has(k)) pairsToFetch.add(`${k}-USD`);
      }
      for (const [k, v] of Object.entries(cachedBinanceBalance)) {
        if (parseFloat(v) > 0.0001 && !stableSet.has(k)) pairsToFetch.add(`${k}-USD`);
      }

      const prices: { exchange: string; pair: string; bid: number; ask: number }[] = [];
      for (const pair of pairsToFetch) {
        const snaps = await Promise.all(FEEDS.map((f) => f.snapshot(pair).catch(() => null)));
        for (const snap of snaps) {
          if (snap && snap.bid > 0 && snap.ask > 0) prices.push({ exchange: snap.exchange, pair: snap.pair, bid: snap.bid, ask: snap.ask });
        }
      }

    // ── Compute arb spreads every tick ──
      const spreads: { pair: string; spread: number; buyExchange: string; sellExchange: string; profitable: boolean }[] = [];
      for (const pair of pairsToFetch) {
      const pairPrices = prices.filter((p) => p.pair === pair);
      if (pairPrices.length < 2) continue;
      let bestSpread = -Infinity;
      let buyEx = '';
      let sellEx = '';
      for (const buyer of pairPrices) {
        for (const seller of pairPrices) {
          if (buyer.exchange === seller.exchange) continue;
          if (buyer.ask <= 0) continue;
          const gross = ((seller.bid - buyer.ask) / buyer.ask) * 100;
          if (!isFinite(gross)) continue;
          if (gross > bestSpread) { bestSpread = gross; buyEx = buyer.exchange; sellEx = seller.exchange; }
        }
      }
      if (bestSpread > -Infinity && isFinite(bestSpread)) {
        spreads.push({ pair, spread: bestSpread, buyExchange: buyEx, sellExchange: sellEx, profitable: bestSpread > 0.36 });
      }
      }
      spreads.sort((a, b) => b.spread - a.spread);

    // Log top spread every 15 ticks (~30s)
      tickCount++;
      if (spreads.length > 0 && tickCount % 15 === 0) {
      const top = spreads[0];
      const feeThreshold = 0.36;
      const gap = (feeThreshold - top.spread).toFixed(3);
      logActivity(`[arb] ${wsCacheSize()} ws prices | ${prices.length} total | best: ${top.pair} ${top.spread.toFixed(4)}% (${top.buyExchange}→${top.sellExchange}) need ${gap}% more`, 'crypto-arb');
      }
      if (spreads.some((s) => s.profitable)) {
      const profitable = spreads.filter((s) => s.profitable);
      for (const s of profitable) {
        logActivity(`[arb] ★ PROFITABLE: ${s.pair} ${s.spread.toFixed(4)}% ${s.buyExchange}→${s.sellExchange}`, 'crypto-arb');
      }
      }

      sourceCtx.state = {
        ...ctx.payload,
        krakenBalance: cachedKrakenBalance,
        binanceBalance: cachedBinanceBalance,
        coinbaseBalance: cachedCoinbaseBalance,
      };

      // ── Run arb evaluation + execution ──
      const items = await cryptoArbSource.poll(sourceCtx);
      const opps: unknown[] = (ctx.payload?.opportunities as unknown[]) ?? [];
      for (const item of items) {
      const strategies = evaluateArbStrategies(item, sourceCtx);
      for (const opp of strategies) {
        opps.push(opp);
        logActivity(`[arb] ⚡ opportunity: ${opp.title} profit=$${opp.projectedProfit.toFixed(4)}`, 'crypto-arb');
        const meta = (opp.metadata as { strategy?: string } | undefined) ?? {};
        if (meta.strategy !== 'inventory-arb') continue;
        if (cryptoArbSource.act) {
          const result = await cryptoArbSource.act(opp, sourceCtx);
          if (result.ok) logActivity(`[arb] ✓ EXECUTED: ${result.message}`, 'crypto-arb');
          else logActivity(`[arb] ✗ skipped: ${result.message}`, 'crypto-arb');
        }
      }
      }
      while (opps.length > 100) opps.shift();

    // ── Save everything every tick ──
    // Always overwrite private fields so stale balances/orders/trades do not
    // survive a failed fetch or a partially-updated worker.
      const payload: Record<string, unknown> = {
      enabled: ctx.payload?.enabled ?? true,
      opportunities: opps,
      prices,
      spreads,
      krakenBalance: cachedKrakenBalance,
      binanceBalance: cachedBinanceBalance,
      coinbaseBalance: cachedCoinbaseBalance,
      recentTrades: cachedRecentTrades,
      openOrders: cachedOpenOrders,
      activityLog: getActivityLog('crypto-arb'),
      rawLog: getRawLog('crypto-arb'),
      daemon: {
        lastTickAt: new Date().toISOString(),
        worker: 'crypto-arb',
        status: 'running',
        version: getB1dzVersion(),
      },
    };
      await ctx.savePayload(payload);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  },
};
