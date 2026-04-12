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
import { GeminiFeed, KrakenFeed, BinanceUsFeed, CoinbaseFeed } from './feeds/index.js';
export { GeminiFeed, KrakenFeed, BinanceUsFeed, CoinbaseFeed, subscribeWs, wsCacheSize, setWsLogger } from './feeds/index.js';
export { getBalance, placeOrder, getOpenOrders, getTradeHistory, MAX_POSITION_USD, KRAKEN_TAKER_FEE, type TradeEntry, type OpenOrder } from './feeds/kraken-private.js';
export {
  getBalance as getBinanceBalance,
  placeOrder as placeBinanceOrder,
  getOpenOrders as getBinanceOpenOrders,
  getRecentTrades as getBinanceTrades,
  BINANCE_TAKER_FEE,
  type BinanceTrade,
} from './feeds/binance-us-private.js';
export { getBalance as getCoinbaseBalance, placeOrder as placeCoinbaseOrder, getOpenOrders as getCoinbaseOpenOrders, getRecentFills as getCoinbaseFills, COINBASE_TAKER_FEE, getCoinbaseAuthDebug } from './feeds/coinbase-private.js';
import { placeOrder as placeKrakenOrder } from './feeds/kraken-private.js';
import { placeOrder as placeBinanceOrder } from './feeds/binance-us-private.js';
import { placeOrder as placeCoinbaseOrder } from './feeds/coinbase-private.js';
import { normalizePair } from './feeds/pairs.js';
import { getActivePairs } from './pair-discovery.js';
export { getActivePairs } from './pair-discovery.js';

const MAX_POSITION_USD = 100;
const SUPPORTED_TRADE_EXCHANGES = new Set(['kraken', 'binance-us', 'coinbase']);

// Feeds — Gemini and Binance.US included for price comparison even if we can't trade on them
const FEEDS: PriceFeed[] = [new GeminiFeed(), new KrakenFeed(), new BinanceUsFeed(), new CoinbaseFeed()];

// Per-exchange taker fee (%)
const TAKER_FEES: Record<string, number> = {
  gemini: 0.004,        // 0.40%
  kraken: 0.0026,       // 0.26%
  'binance-us': 0.001,  // 0.10%
  coinbase: 0.006,      // 0.60%
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
      if (!isFinite(buyer.ask) || !isFinite(seller.bid) || buyer.ask <= 0 || seller.bid <= 0) continue;
      // Buy at buyer's ask, sell at seller's bid
      const buyFee = TAKER_FEES[buyer.exchange] ?? 0.005;
      const sellFee = TAKER_FEES[seller.exchange] ?? 0.005;
      const grossPerUnit = seller.bid - buyer.ask;
      const fees = buyer.ask * buyFee + seller.bid * sellFee;
      const netPerUnit = grossPerUnit - fees;
      if (!isFinite(netPerUnit) || netPerUnit <= 0) continue;
      const result: ArbResult = {
        pair: buyer.pair,
        buyExchange: buyer.exchange,
        sellExchange: seller.exchange,
        buyPrice: buyer.ask,
        sellPrice: seller.bid,
        spreadPct: (grossPerUnit / buyer.ask) * 100,
        netPerUnit,
      };
      if (!isFinite(result.spreadPct)) continue;
      if (!best || result.netPerUnit > best.netPerUnit) best = result;
    }
  }
  return best;
}

export const cryptoArbSource: Source<ArbItem> = {
  id: 'crypto-arb',
  pollIntervalMs: 1000, // arb windows close fast
  async poll() {
    const PAIRS = await getActivePairs();
    const items: ArbItem[] = [];
    for (const pair of PAIRS) {
      const snaps = (await Promise.all(FEEDS.map((f) => f.snapshot(pair))))
        .filter((s): s is MarketSnapshot => s != null);
      if (snaps.length >= 2) {
        items.push({ pair, snapshots: snaps });
      }
    }
    return items;
  },
  evaluate(item): Opportunity | null {
    const arb = bestArb(item.snapshots);
    if (!arb) return null;
    if (!SUPPORTED_TRADE_EXCHANGES.has(arb.buyExchange) || !SUPPORTED_TRADE_EXCHANGES.has(arb.sellExchange)) {
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
    if (!SUPPORTED_TRADE_EXCHANGES.has(arb.buyExchange) || !SUPPORTED_TRADE_EXCHANGES.has(arb.sellExchange)) {
      return { ok: false, message: `unsupported exchange (${arb.buyExchange}/${arb.sellExchange})`, permanent: true };
    }
    if (
      !isFinite(arb.buyPrice)
      || !isFinite(arb.sellPrice)
      || !isFinite(arb.size)
      || arb.buyPrice <= 0
      || arb.sellPrice <= 0
      || arb.size <= 0
    ) {
      return { ok: false, message: 'invalid arb quote', permanent: true };
    }

    // Size to stay within $100
    const maxVolume = MAX_POSITION_USD / arb.buyPrice;
    const volume = Math.min(arb.size, maxVolume);
    const cost = volume * arb.buyPrice;
    const revenue = volume * arb.sellPrice;
    const buyFee = cost * (TAKER_FEES[arb.buyExchange] ?? 0.005);
    const sellFee = revenue * (TAKER_FEES[arb.sellExchange] ?? 0.005);
    const netProfit = revenue - cost - buyFee - sellFee;

    if (!isFinite(netProfit) || netProfit <= 0) {
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
      } else if (arb.buyExchange === 'coinbase') {
        const result = await placeCoinbaseOrder({
          productId: arb.pair,
          side: 'BUY',
          size: volume.toFixed(8),
          limitPrice: arb.buyPrice.toFixed(2),
        });
        console.log(`[arb] BUY on coinbase: orderId=${result.order_id}`);
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
      } else if (arb.sellExchange === 'coinbase') {
        const result = await placeCoinbaseOrder({
          productId: arb.pair,
          side: 'SELL',
          size: volume.toFixed(8),
          limitPrice: arb.sellPrice.toFixed(2),
        });
        console.log(`[arb] SELL on coinbase: orderId=${result.order_id}`);
      }

      return { ok: true, message: `arb executed, net ~$${netProfit.toFixed(4)}` };
    } catch (e) {
      console.error(`[arb] ORDER FAILED: ${(e as Error).message}`);
      return { ok: false, message: (e as Error).message };
    }
  },
};
