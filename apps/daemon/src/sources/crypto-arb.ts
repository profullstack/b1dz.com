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
const PRIVATE_FETCH_INTERVAL = 60_000;

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

    // ── Fetch balances FIRST (before slow price polling) ──
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

      // Quick price fetch for major coins so TUI can value crypto holdings
      const quickPrices: { exchange: string; pair: string; bid: number; ask: number }[] = [];
      const krakenFeed = FEEDS.find((f) => f.exchange === 'kraken');
      if (krakenFeed) {
        for (const pair of ['BTC-USD', 'ETH-USD', 'SOL-USD']) {
          try {
            const snap = await krakenFeed.snapshot(pair);
            if (snap) quickPrices.push({ exchange: snap.exchange, pair: snap.pair, bid: snap.bid, ask: snap.ask });
          } catch {}
        }
      }

      // Save balances + quick prices immediately so TUI has data
      await ctx.savePayload({
        enabled: ctx.payload?.enabled ?? true,
        prices: quickPrices,
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
    }

    // ── Poll prices for top pairs ──
    const PAIRS = await getActivePairs();
    const prices: { exchange: string; pair: string; bid: number; ask: number }[] = [];
    for (const pair of PAIRS) {
      const snaps = (await Promise.all(FEEDS.map((f) => f.snapshot(pair))))
        .filter((s): s is MarketSnapshot => s != null);
      for (const s of snaps) {
        prices.push({ exchange: s.exchange, pair: s.pair, bid: s.bid, ask: s.ask });
      }
    }

    // Compute arb spreads
    const spreads: { pair: string; spread: number; buyExchange: string; sellExchange: string; profitable: boolean }[] = [];
    for (const pair of PAIRS) {
      const pairPrices = prices.filter((p) => p.pair === pair);
      let bestSpread = -Infinity;
      let buyEx = '';
      let sellEx = '';
      for (const buyer of pairPrices) {
        for (const seller of pairPrices) {
          if (buyer.exchange === seller.exchange) continue;
          const gross = ((seller.bid - buyer.ask) / buyer.ask) * 100;
          if (gross > bestSpread) {
            bestSpread = gross;
            buyEx = buyer.exchange;
            sellEx = seller.exchange;
          }
        }
      }
      spreads.push({
        pair,
        spread: bestSpread === -Infinity ? 0 : bestSpread,
        buyExchange: buyEx,
        sellExchange: sellEx,
        profitable: bestSpread > 0.36,
      });
    }

    // Run arb evaluation + execution
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

    // Save full state
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
