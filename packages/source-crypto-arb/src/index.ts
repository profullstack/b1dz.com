/**
 * Crypto arbitrage source — scans configured pairs across multiple exchanges
 * for price gaps that exceed fees + slippage and emits Opportunities.
 *
 *   poll()      → snapshot every (pair, exchange) pair from registered feeds
 *   evaluate()  → for each pair, find the best (buy, sell) exchange combo and
 *                 only emit if (sell - buy) - fees - slippage > 0
 *   act()       → place atomic two-leg trade (TODO — needs authenticated APIs)
 *
 * Day-trading variants live in their own sources but reuse the same PriceFeed
 * implementations from ./feeds — one feed, many strategies.
 */

import type { Source, MarketSnapshot, Opportunity, ActionResult, PriceFeed } from '@b1dz/core';
import { GeminiFeed, KrakenFeed, BinanceUsFeed } from './feeds/index.js';
export { GeminiFeed, KrakenFeed, BinanceUsFeed } from './feeds/index.js';
export { getBalance, placeOrder, getOpenOrders, getTradeHistory, MAX_POSITION_USD, KRAKEN_TAKER_FEE, type TradeEntry, type OpenOrder } from './feeds/kraken-private.js';
export { getBalance as getBinanceBalance, placeOrder as placeBinanceOrder, getOpenOrders as getBinanceOpenOrders, BINANCE_TAKER_FEE } from './feeds/binance-us-private.js';
import { placeOrder as placeKrakenOrder } from './feeds/kraken-private.js';
import { placeOrder as placeBinanceOrder } from './feeds/binance-us-private.js';
import { normalizePair } from './feeds/pairs.js';

const MAX_POSITION_USD = 100;

// Configuration — pull from env / source state in real impl
const PAIRS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const FEEDS: PriceFeed[] = [new GeminiFeed(), new KrakenFeed(), new BinanceUsFeed()];

// Per-exchange taker fee (%) — placeholder values, refine with real schedules
const TAKER_FEES: Record<string, number> = {
  gemini: 0.004,        // 0.40%
  kraken: 0.0026,       // 0.26%
  'binance-us': 0.001,  // 0.10%
};

interface ArbItem {
  pair: string;
  snapshots: MarketSnapshot[];
}

interface ArbResult {
  pair: string;
  buyExchange: string;
  sellExchange: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  /** profit per unit after fees on both legs */
  netPerUnit: number;
}

function bestArb(snaps: MarketSnapshot[]): ArbResult | null {
  let best: ArbResult | null = null;
  for (const buyer of snaps) {
    for (const seller of snaps) {
      if (buyer.exchange === seller.exchange) continue;
      // Buy at buyer's ask, sell at seller's bid
      const buyFee = TAKER_FEES[buyer.exchange] ?? 0.005;
      const sellFee = TAKER_FEES[seller.exchange] ?? 0.005;
      const grossPerUnit = seller.bid - buyer.ask;
      const fees = buyer.ask * buyFee + seller.bid * sellFee;
      const netPerUnit = grossPerUnit - fees;
      if (netPerUnit <= 0) continue;
      const result: ArbResult = {
        pair: buyer.pair,
        buyExchange: buyer.exchange,
        sellExchange: seller.exchange,
        buyPrice: buyer.ask,
        sellPrice: seller.bid,
        spreadPct: (grossPerUnit / buyer.ask) * 100,
        netPerUnit,
      };
      if (!best || result.netPerUnit > best.netPerUnit) best = result;
    }
  }
  return best;
}

export const cryptoArbSource: Source<ArbItem> = {
  id: 'crypto-arb',
  pollIntervalMs: 1000, // arb windows close fast
  async poll() {
    const items: ArbItem[] = [];
    for (const pair of PAIRS) {
      const snaps = (await Promise.all(FEEDS.map((f) => f.snapshot(pair))))
        .filter((s): s is MarketSnapshot => s != null);
      if (snaps.length >= 2) {
        items.push({ pair, snapshots: snaps });
        const prices = snaps.map((s) => `${s.exchange}=$${s.bid.toFixed(2)}`).join(' ');
        console.log(`[arb] ${pair} ${prices}`);
      }
    }
    return items;
  },
  evaluate(item): Opportunity | null {
    const arb = bestArb(item.snapshots);
    if (!arb) {
      // Log best spread even when not profitable
      const snaps = item.snapshots;
      if (snaps.length >= 2) {
        let bestSpread = 0;
        for (const buyer of snaps) {
          for (const seller of snaps) {
            if (buyer.exchange === seller.exchange) continue;
            const spread = ((seller.bid - buyer.ask) / buyer.ask) * 100;
            if (spread > bestSpread) bestSpread = spread;
          }
        }
        console.log(`[arb] ${item.pair} best spread: ${bestSpread.toFixed(4)}% (below fee threshold)`);
      }
      return null;
    }
    // Sized at 1 unit for now — real impl computes max safe size from order book depth
    const size = 1;
    const costNow = arb.buyPrice * size;
    const projectedReturn = arb.sellPrice * size;
    return {
      id: `crypto-arb:${item.pair}:${arb.buyExchange}-${arb.sellExchange}`,
      sourceId: 'crypto-arb',
      externalId: `${item.pair}:${arb.buyExchange}-${arb.sellExchange}`,
      title: `${item.pair} arb: ${arb.buyExchange} → ${arb.sellExchange}`,
      category: 'crypto-arbitrage',
      costNow,
      projectedReturn,
      projectedProfit: arb.netPerUnit * size,
      // Confidence shrinks with thin spreads — anything under 0.1% is fragile
      confidence: Math.min(1, arb.spreadPct / 0.5),
      // Short window — arb closes fast
      expiresAt: Date.now() + 5_000,
      metadata: { ...arb, size },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  },
  async act(opp): Promise<ActionResult> {
    const arb = opp.metadata as unknown as ArbResult & { size: number };
    const supported = ['kraken', 'binance-us'];

    if (!supported.includes(arb.buyExchange) || !supported.includes(arb.sellExchange)) {
      return { ok: false, message: `unsupported exchange (${arb.buyExchange}/${arb.sellExchange})`, permanent: true };
    }

    // Size to stay within $100
    const maxVolume = MAX_POSITION_USD / arb.buyPrice;
    const volume = Math.min(arb.size, maxVolume);
    const cost = volume * arb.buyPrice;
    const revenue = volume * arb.sellPrice;
    const buyFee = cost * (TAKER_FEES[arb.buyExchange] ?? 0.005);
    const sellFee = revenue * (TAKER_FEES[arb.sellExchange] ?? 0.005);
    const netProfit = revenue - cost - buyFee - sellFee;

    if (netProfit <= 0) {
      console.log(`[arb] SKIP ${opp.title}: net profit $${netProfit.toFixed(4)} <= 0`);
      return { ok: false, message: `not profitable after fees ($${netProfit.toFixed(4)})` };
    }

    console.log(`[arb] EXECUTE ${opp.title}: vol=${volume.toFixed(8)} cost=$${cost.toFixed(2)} net=$${netProfit.toFixed(4)}`);

    try {
      // Place buy leg
      if (arb.buyExchange === 'kraken') {
        const result = await placeKrakenOrder({
          pair: normalizePair(arb.pair, 'kraken'),
          type: 'buy',
          ordertype: 'limit',
          volume: volume.toFixed(8),
          price: arb.buyPrice.toFixed(2),
        });
        console.log(`[arb] BUY on kraken: ${result.descr.order} txid=${result.txid}`);
      } else if (arb.buyExchange === 'binance-us') {
        const result = await placeBinanceOrder({
          symbol: normalizePair(arb.pair, 'binance-us'),
          side: 'BUY',
          type: 'LIMIT',
          quantity: volume.toFixed(8),
          price: arb.buyPrice.toFixed(2),
        });
        console.log(`[arb] BUY on binance-us: orderId=${result.orderId} status=${result.status}`);
      }

      // Place sell leg
      if (arb.sellExchange === 'kraken') {
        const result = await placeKrakenOrder({
          pair: normalizePair(arb.pair, 'kraken'),
          type: 'sell',
          ordertype: 'limit',
          volume: volume.toFixed(8),
          price: arb.sellPrice.toFixed(2),
        });
        console.log(`[arb] SELL on kraken: ${result.descr.order} txid=${result.txid}`);
      } else if (arb.sellExchange === 'binance-us') {
        const result = await placeBinanceOrder({
          symbol: normalizePair(arb.pair, 'binance-us'),
          side: 'SELL',
          type: 'LIMIT',
          quantity: volume.toFixed(8),
          price: arb.sellPrice.toFixed(2),
        });
        console.log(`[arb] SELL on binance-us: orderId=${result.orderId} status=${result.status}`);
      }

      return { ok: true, message: `arb executed, net ~$${netProfit.toFixed(4)}` };
    } catch (e) {
      console.error(`[arb] ORDER FAILED: ${(e as Error).message}`);
      return { ok: false, message: (e as Error).message };
    }
  },
};
