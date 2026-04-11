import type { SourceWorker, UserContext } from '../types.js';
import {
  cryptoArbSource,
  KrakenFeed, BinanceUsFeed, CoinbaseFeed,
  getBalance, getBinanceBalance, getCoinbaseBalance,
  getTradeHistory, getOpenOrders,
  getActivePairs,
} from '@b1dz/source-crypto-arb';
import { AlertBus } from '@b1dz/core';
import { runnerStorageFor } from '../runner-storage.js';
import type { MarketSnapshot } from '@b1dz/core';

const FEEDS = [new KrakenFeed(), new BinanceUsFeed(), new CoinbaseFeed()];

// Cache private API data — refresh every 60s
let cachedKrakenBalance: Record<string, string> = {};
let cachedBinanceBalance: Record<string, string> = {};
let cachedCoinbaseBalance: Record<string, string> = {};
let cachedRecentTrades: unknown[] = [];
let cachedOpenOrders: unknown[] = [];
let lastPrivateFetch = 0;
const PRIVATE_FETCH_INTERVAL = 15_000; // 15s — balances/trades/orders

const krakenNameMap: Record<string, string> = { XXBT: 'BTC', XETH: 'ETH', XXDG: 'DOGE', XZEC: 'ZEC', XXRP: 'XRP', XXLM: 'XLM', XXMR: 'XMR' };
const stableSet = new Set(['ZUSD', 'USD', 'USDC', 'USDT']);

export const cryptoArbWorker: SourceWorker = {
  id: 'crypto-arb',
  pollIntervalMs: 2000,
  hasCredentials(payload) {
    return !!(payload?.enabled);
  },
  async tick(ctx: UserContext) {
    const storage = runnerStorageFor(ctx);
    const alerts = new AlertBus();
    const sourceCtx = { storage, alerts, state: ctx.payload };

    // ── Fetch balances + trade history every 60s (private API, rate limited) ──
    if (Date.now() - lastPrivateFetch > PRIVATE_FETCH_INTERVAL) {
      lastPrivateFetch = Date.now();
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      try {
        cachedKrakenBalance = await getBalance();
        console.log('b1dzd: kraken balance:', Object.entries(cachedKrakenBalance).filter(([, v]) => parseFloat(v) > 0.0001).map(([k, v]) => `${k}=${v}`).join(' '));
        await wait(2000);
        const th = await getTradeHistory();
        cachedRecentTrades = Object.values(th).sort((a, b) => b.time - a.time).slice(0, 20);
        await wait(2000);
        const oo = await getOpenOrders();
        cachedOpenOrders = Object.entries(oo).map(([id, o]) => ({ id, ...o }));
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('Rate limit')) {
          console.error('b1dzd: kraken rate limited, backing off 60s');
          lastPrivateFetch = Date.now() + 60_000;
        } else {
          console.error(`b1dzd: kraken private API error: ${msg}`);
        }
      }
      try {
        cachedBinanceBalance = await getBinanceBalance();
        console.log('b1dzd: binance balance:', Object.entries(cachedBinanceBalance).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)');
      } catch (e) {
        console.error(`b1dzd: binance balance error: ${(e as Error).message}`);
      }
      try {
        cachedCoinbaseBalance = await getCoinbaseBalance();
        console.log('b1dzd: coinbase balance:', Object.entries(cachedCoinbaseBalance).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)');
      } catch (e) {
        console.error(`b1dzd: coinbase balance error: ${(e as Error).message}`);
      }
    }

    // ── Fetch prices every tick (public API, no rate limit issues) ──
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
        if (snap) prices.push({ exchange: snap.exchange, pair: snap.pair, bid: snap.bid, ask: snap.ask });
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
          const gross = ((seller.bid - buyer.ask) / buyer.ask) * 100;
          if (gross > bestSpread) { bestSpread = gross; buyEx = buyer.exchange; sellEx = seller.exchange; }
        }
      }
      if (bestSpread > -Infinity) {
        spreads.push({ pair, spread: bestSpread, buyExchange: buyEx, sellExchange: sellEx, profitable: bestSpread > 0.36 });
      }
    }
    spreads.sort((a, b) => b.spread - a.spread);

    // ── Run arb evaluation + execution ──
    const items = await cryptoArbSource.poll(sourceCtx);
    const opps: unknown[] = (ctx.payload?.opportunities as unknown[]) ?? [];
    for (const item of items) {
      const opp = cryptoArbSource.evaluate(item, sourceCtx);
      if (!opp) continue;
      opps.push(opp);
      if (cryptoArbSource.act) {
        const result = await cryptoArbSource.act(opp, sourceCtx);
        if (result.ok) console.log(`b1dzd: arb executed: ${result.message}`);
      }
    }
    while (opps.length > 100) opps.shift();

    // ── Save everything every tick ──
    await ctx.savePayload({
      enabled: ctx.payload?.enabled ?? true,
      opportunities: opps,
      prices,
      spreads,
      krakenBalance: cachedKrakenBalance,
      binanceBalance: cachedBinanceBalance,
      coinbaseBalance: cachedCoinbaseBalance,
      recentTrades: cachedRecentTrades,
      openOrders: cachedOpenOrders,
      daemon: {
        lastTickAt: new Date().toISOString(),
        worker: 'crypto-arb',
        status: 'running',
      },
    });
  },
};
