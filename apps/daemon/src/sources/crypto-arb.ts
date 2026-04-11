import type { SourceWorker, UserContext } from '../types.js';
import {
  cryptoArbSource,
  GeminiFeed, KrakenFeed, BinanceUsFeed,
  getBalance, getBinanceBalance,
  getTradeHistory, getOpenOrders,
} from '@b1dz/source-crypto-arb';
import { AlertBus } from '@b1dz/core';
import { runnerStorageFor } from '../runner-storage.js';
import type { MarketSnapshot } from '@b1dz/core';

const PAIRS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const FEEDS = [new KrakenFeed(), new BinanceUsFeed()];

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

    // Poll prices for all pairs across all feeds
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

    // Fetch balances + trade history (Kraken private API)
    let krakenBalance: Record<string, string> = {};
    let binanceBalance: Record<string, string> = {};
    let recentTrades: unknown[] = [];
    let openOrders: unknown[] = [];
    try {
      krakenBalance = await getBalance();
    } catch {}
    try {
      binanceBalance = await getBinanceBalance();
    } catch {}
    try {
      const th = await getTradeHistory();
      recentTrades = Object.values(th).sort((a, b) => b.time - a.time).slice(0, 20);
    } catch {}
    try {
      const oo = await getOpenOrders();
      openOrders = Object.entries(oo).map(([id, o]) => ({ id, ...o }));
    } catch {}

    // Persist everything for the TUI to read
    await ctx.savePayload({
      opportunities: opps,
      prices,
      spreads,
      krakenBalance,
      binanceBalance,
      recentTrades,
      openOrders,
      daemon: {
        lastTickAt: new Date().toISOString(),
        worker: 'crypto-arb',
        status: 'running',
      },
    });
  },
};
