import type { SourceWorker, UserContext } from '../types.js';
import {
  cryptoArbSource,
  evaluateArbStrategies,
  KrakenFeed, BinanceUsFeed, CoinbaseFeed,
  getBalance, getBinanceBalance, getCoinbaseBalance, getCoinbaseAuthDebug,
  getBinanceDetailedBalance, getBinanceOpenOrders,
  getGeminiBalance,
  getTradeHistory, getOpenOrders,
  getActivePairs,
  subscribeWs, wsCacheSize, setWsLogger,
  type BinanceAssetBalance,
  // Auto-seeder
  decideSeed,
  recordSeed,
  evaluateCircuitBreakers,
  normalizeSeedState,
  stableBalanceOf,
  seedKey,
  placeSeedOrder,
  SEED_STATE_PAYLOAD_KEY,
  type SeedState,
  type SeedDecisionKind,
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
let cachedGeminiBalance: Record<string, string> = {};
let cachedBinanceDetailedBalance: BinanceAssetBalance[] = [];
let cachedBinanceOpenOrders: unknown[] = [];
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

// ── Auto-seeder state ─────────────────────────────────────────────────
// The seed ledger is persisted per-user via ctx.payload, but we also keep
// a module-level shadow so we don't clobber the ledger when concurrent
// ticks race or when a partial persist fails mid-flight.
let cachedSeedState: SeedState = { entries: {}, totalSeedCostUsd: 0 };
let cachedSeedStateLoaded = false;
/** Realized arb profit attributed to each (exchange, pair) — used by the
 *  circuit breaker to decide if a seeded pair is actually earning. We
 *  compute this lazily from the crypto-trade closedTrades ring each tick. */
function computeRealizedProfitByKey(closedTrades: Array<{ exchange?: string; pair?: string; netPnl?: number; exitTime?: number }>, sinceMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of closedTrades) {
    if (!t || typeof t.pair !== 'string') continue;
    // Attribute the trade to the venue where it closed (sell-side inventory
    // spend → sell-side closes are what "paid back" the seed).
    const ex = typeof t.exchange === 'string' ? t.exchange : '';
    if (!ex) continue;
    if (typeof t.exitTime === 'number' && t.exitTime < sinceMs) continue;
    const key = seedKey(ex, t.pair);
    const net = typeof t.netPnl === 'number' && Number.isFinite(t.netPnl) ? t.netPnl : 0;
    out[key] = (out[key] ?? 0) + net;
  }
  return out;
}

/** Short, fixed-width label for a seed decision — rendered in the TUI
 *  Arb Spreads panel next to each profitable row. Max ~12 chars so the
 *  column stays aligned with existing PROFIT/info labels. */
function labelForDecision(d: SeedDecisionKind): string {
  switch (d.kind) {
    case 'seed': return `→ SEED $${d.sizeUsd.toFixed(0)}`;
    case 'inventory-ready': return '✓ READY';
    case 'cooldown': return `⊘ cd ${Math.ceil(d.remainingMs / 60_000)}m`;
    case 'paused': return '⊘ paused';
    case 'budget-pair-exhausted': return '⊘ pair $';
    case 'budget-global-exhausted': return '⊘ global $';
    case 'no-stable-balance': return '⊘ no USDC';
    case 'seed-too-small': return '⊘ too small';
    case 'disabled': return 'ℹ disabled';
  }
}

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
        cachedBinanceDetailedBalance = await getBinanceDetailedBalance();
      } catch (e) {
        cachedBinanceDetailedBalance = [];
        logRaw(`[binance] ✗ detailed balance: ${(e as Error).message}`, 'crypto-arb');
      }
      try {
        cachedBinanceOpenOrders = await getBinanceOpenOrders();
      } catch (e) {
        cachedBinanceOpenOrders = [];
        logRaw(`[binance] ✗ open orders: ${(e as Error).message}`, 'crypto-arb');
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
      try {
        cachedGeminiBalance = await getGeminiBalance();
        logRaw(`[gemini] balance: ${Object.entries(cachedGeminiBalance).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)'}`, 'crypto-arb');
      } catch (e) {
        cachedGeminiBalance = {};
        logRaw(`[gemini] ✗ Unable to connect: ${(e as Error).message}`, 'crypto-arb');
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
      const spreads: { pair: string; spread: number; buyExchange: string; sellExchange: string; profitable: boolean; seedStatus?: SeedDecisionKind | null; seedLabel?: string }[] = [];
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
      logActivity(`[arb][spread] ${wsCacheSize()} ws prices | ${prices.length} total | best: ${top.pair} ${top.spread.toFixed(4)}% (${top.buyExchange}→${top.sellExchange}) need ${gap}% more`, 'crypto-arb');
      }
      if (spreads.some((s) => s.profitable)) {
      const profitable = spreads.filter((s) => s.profitable);
      for (const s of profitable) {
        logActivity(`[arb][spread] ★ PROFITABLE: ${s.pair} ${s.spread.toFixed(4)}% ${s.buyExchange}→${s.sellExchange}`, 'crypto-arb');
      }
      }

      sourceCtx.state = {
        ...ctx.payload,
        krakenBalance: cachedKrakenBalance,
        binanceBalance: cachedBinanceBalance,
        coinbaseBalance: cachedCoinbaseBalance,
        geminiBalance: cachedGeminiBalance,
      };

      // ── Run arb evaluation + execution ──
      const items = await cryptoArbSource.poll(sourceCtx);
      const opps: unknown[] = (ctx.payload?.opportunities as unknown[]) ?? [];
      for (const item of items) {
      const strategies = evaluateArbStrategies(item, sourceCtx);
      for (const opp of strategies) {
        opps.push(opp);
        const meta = (opp.metadata as { strategy?: string } | undefined) ?? {};
        const strategyTag = meta.strategy ?? 'spread';
        logActivity(`[arb][${strategyTag}] ⚡ opportunity: ${opp.title} profit=$${opp.projectedProfit.toFixed(4)}`, 'crypto-arb');
        if (meta.strategy !== 'inventory-arb') continue;
        if (cryptoArbSource.act) {
          const result = await cryptoArbSource.act(opp, sourceCtx);
          if (result.ok) logActivity(`[arb][inventory-arb] ✓ EXECUTED: ${result.message}`, 'crypto-arb');
          else logActivity(`[arb][inventory-arb] ✗ skipped: ${result.message}`, 'crypto-arb');
        }
      }
      }
      while (opps.length > 100) opps.shift();

      // ── Auto-seed inventory for profitable spread opps that lack inventory ──
      // See packages/source-crypto-arb/src/seeder.ts for the full rationale
      // and the guarantees it enforces (per-pair/global budget, cooldown,
      // circuit breaker, stables-only, trading toggle).
      if (!cachedSeedStateLoaded) {
        cachedSeedState = normalizeSeedState(ctx.payload?.[SEED_STATE_PAYLOAD_KEY]);
        cachedSeedStateLoaded = true;
      }

      // Resolve trading toggle (same priority as crypto-trade worker):
      // UI setting → TRADING_ENABLED env → default true.
      let tradingEnabled = true;
      try {
        const uiSettings = await storage.get<{ tradingEnabled?: boolean | null }>('source-state', 'crypto-ui-settings');
        const uiOverride = uiSettings?.tradingEnabled;
        if (uiOverride === false || uiOverride === true) {
          tradingEnabled = uiOverride;
        } else {
          const envRaw = (process.env.TRADING_ENABLED ?? '').trim().toLowerCase();
          if (envRaw === 'false') tradingEnabled = false;
        }
      } catch {
        // Fall through — conservative default is "enabled", same as crypto-trade.
      }

      // Stable balance per exchange (USDC → USDT → USD priority).
      const stableByExchange: Record<string, number> = {
        kraken: stableBalanceOf(cachedKrakenBalance),
        'binance-us': stableBalanceOf(cachedBinanceBalance),
        coinbase: stableBalanceOf(cachedCoinbaseBalance),
        gemini: stableBalanceOf(cachedGeminiBalance),
      };

      // Base inventory lookup: how many base-asset units we hold on a venue.
      function baseInventoryOn(exchange: string, baseAsset: string): number {
        const bal = exchange === 'kraken' ? cachedKrakenBalance
          : exchange === 'binance-us' ? cachedBinanceBalance
          : exchange === 'coinbase' ? cachedCoinbaseBalance
          : exchange === 'gemini' ? cachedGeminiBalance
          : {};
        // Kraken uses aliases (XXDG vs DOGE). Check both.
        if (exchange === 'kraken') {
          for (const alias of [`X${baseAsset}`, `XX${baseAsset}`, baseAsset]) {
            const amt = parseFloat(bal[alias] ?? '0');
            if (Number.isFinite(amt) && amt > 0) return amt;
          }
          return 0;
        }
        const amt = parseFloat(bal[baseAsset] ?? '0');
        return Number.isFinite(amt) && amt > 0 ? amt : 0;
      }

      // Circuit-breaker eval: read closed trades from crypto-trade payload so
      // we can judge whether seeded pairs are earning. `sinceMs` = last seed
      // time per entry is handled inside evaluateCircuitBreakers — we pass a
      // "0" baseline and let the module itself scope by lastSeededAtMs when
      // computing elapsed windows.
      try {
        const tradePayload = await storage.get<{ tradeState?: { closedTrades?: Array<{ exchange?: string; pair?: string; netPnl?: number; exitTime?: number }> } }>('source-state', 'crypto-trade');
        const closedTrades = tradePayload?.tradeState?.closedTrades ?? [];
        const realizedByKey = computeRealizedProfitByKey(closedTrades, 0);
        cachedSeedState = evaluateCircuitBreakers(cachedSeedState, {
          nowMs: Date.now(),
          realizedProfitByKey: realizedByKey,
        });
      } catch {
        // Non-fatal: circuit breaker just doesn't advance this tick.
      }

      // For each profitable spread, decide whether to seed.
      for (const s of spreads) {
        if (!s.profitable) { s.seedStatus = null; continue; }
        const base = s.pair.split('-')[0] ?? '';
        if (!base) { s.seedStatus = null; continue; }
        const sellPrice = prices.find((p) => p.exchange === s.sellExchange && p.pair === s.pair)?.bid ?? 0;
        const buyPrice = prices.find((p) => p.exchange === s.buyExchange && p.pair === s.pair)?.ask ?? 0;
        const decision = decideSeed({
          key: seedKey(s.sellExchange, s.pair),
          exchange: s.sellExchange,
          pair: s.pair,
          currentBaseInventory: baseInventoryOn(s.sellExchange, base),
          stableBalanceOnExchange: stableByExchange[s.sellExchange] ?? 0,
          nowMs: Date.now(),
          tradingEnabled,
          state: cachedSeedState,
          refPriceUsd: sellPrice > 0 ? sellPrice : buyPrice,
        });
        s.seedStatus = decision;
        // Human-readable label for the TUI (kept short).
        s.seedLabel = labelForDecision(decision);

        if (decision.kind === 'seed') {
          logActivity(`[arb][seed] → SEEDING $${decision.sizeUsd.toFixed(2)} ${decision.exchange}:${decision.pair}`, 'crypto-arb');
          const ask = prices.find((p) => p.exchange === s.sellExchange && p.pair === s.pair)?.ask ?? 0;
          const result = await placeSeedOrder({
            exchange: decision.exchange,
            pair: decision.pair,
            sizeUsd: decision.sizeUsd,
            askPriceUsd: ask,
          });
          if (result.ok && result.filledCostUsd > 0) {
            cachedSeedState = recordSeed(cachedSeedState, {
              key: seedKey(decision.exchange, decision.pair),
              costUsd: result.filledCostUsd,
              nowMs: Date.now(),
            });
            logActivity(`[arb][seed] ✓ seeded ${result.filledVolume.toFixed(8)} ${base} on ${decision.exchange} for $${result.filledCostUsd.toFixed(2)} (ref=${result.orderRef})`, 'crypto-arb');
          } else {
            logActivity(`[arb][seed] ✗ failed ${decision.exchange}:${decision.pair}: ${result.error ?? 'unknown'}`, 'crypto-arb');
          }
        }
      }

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
      geminiBalance: cachedGeminiBalance,
      binanceDetailedBalance: cachedBinanceDetailedBalance,
      binanceOpenOrders: cachedBinanceOpenOrders,
      recentTrades: cachedRecentTrades,
      openOrders: cachedOpenOrders,
      [SEED_STATE_PAYLOAD_KEY]: cachedSeedState,
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
