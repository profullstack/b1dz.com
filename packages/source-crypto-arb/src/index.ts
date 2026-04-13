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
export { GeminiFeed, KrakenFeed, BinanceUsFeed, CoinbaseFeed, subscribeWs, getWsSnapshot, getAllSnapshots, wsCacheSize, setWsLogger } from './feeds/index.js';
export { getBalance, placeOrder, getOpenOrders, cancelOrder as cancelKrakenOrder, getTradeHistory, getPairMinVolume as getKrakenPairMinVolume, MAX_POSITION_USD, KRAKEN_TAKER_FEE, type TradeEntry, type OpenOrder } from './feeds/kraken-private.js';
export { hasTradingPair as hasKrakenTradingPair } from './feeds/kraken-private.js';
export {
  getBalance as getBinanceBalance,
  placeOrder as placeBinanceOrder,
  getOpenOrders as getBinanceOpenOrders,
  getRecentTrades as getBinanceTrades,
  getTradingRules as getBinanceTradingRules,
  hasTradingSymbol as hasBinanceTradingSymbol,
  BINANCE_TAKER_FEE,
  type BinanceTrade,
} from './feeds/binance-us-private.js';
export { getBalance as getCoinbaseBalance, placeOrder as placeCoinbaseOrder, getOpenOrders as getCoinbaseOpenOrders, getRecentFills as getCoinbaseFills, COINBASE_TAKER_FEE, getCoinbaseAuthDebug, hasTradingProduct as hasCoinbaseTradingProduct } from './feeds/coinbase-private.js';
import { placeOrder as placeKrakenOrder } from './feeds/kraken-private.js';
import { placeOrder as placeBinanceOrder } from './feeds/binance-us-private.js';
import { placeOrder as placeCoinbaseOrder } from './feeds/coinbase-private.js';
import { normalizePair } from './feeds/pairs.js';
import { getActivePairs } from './pair-discovery.js';
export { getActivePairs } from './pair-discovery.js';
export { normalizePair } from './feeds/pairs.js';

const MAX_POSITION_USD = 100;
const MIN_EXECUTABLE_USD = 5;
const SUPPORTED_TRADE_EXCHANGES = new Set(['kraken', 'binance-us', 'coinbase']);
const STABLE_ASSETS = ['USD', 'USDC', 'USDT'];
const KRAKEN_ASSET_ALIASES: Record<string, string[]> = {
  BTC: ['XXBT', 'XBT', 'BTC'],
  ETH: ['XETH', 'ETH'],
  DOGE: ['XXDG', 'XDG', 'DOGE'],
  ZEC: ['XZEC', 'ZEC'],
  XRP: ['XXRP', 'XRP'],
  XLM: ['XXLM', 'XLM'],
  XMR: ['XXMR', 'XMR'],
  LTC: ['XLTC', 'LTC'],
  ADA: ['XADA', 'ADA'],
  SOL: ['XSOL', 'SOL'],
};

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

export type ArbStrategyId = 'spread' | 'inventory-arb';

function readBalanceMap(ctx: Parameters<Source<ArbItem>['evaluate']>[1], exchange: string): Record<string, string> {
  if (exchange === 'kraken') return (ctx.state.krakenBalance as Record<string, string> | undefined) ?? {};
  if (exchange === 'binance-us') return (ctx.state.binanceBalance as Record<string, string> | undefined) ?? {};
  if (exchange === 'coinbase') return (ctx.state.coinbaseBalance as Record<string, string> | undefined) ?? {};
  return {};
}

function exchangeAssetBalance(exchange: string, asset: string, balance: Record<string, string>): number {
  const aliases = exchange === 'kraken'
    ? (KRAKEN_ASSET_ALIASES[asset] ?? [asset])
    : [asset];
  for (const alias of aliases) {
    const amount = parseFloat(balance[alias] ?? '0');
    if (isFinite(amount) && amount > 0) return amount;
  }
  return 0;
}

function quoteBalance(exchange: string, balance: Record<string, string>): number {
  const assets = exchange === 'kraken' ? ['ZUSD', ...STABLE_ASSETS] : STABLE_ASSETS;
  return assets.reduce((sum, asset) => {
    const amount = parseFloat(balance[asset] ?? '0');
    return isFinite(amount) ? sum + amount : sum;
  }, 0);
}

function executableInventorySize(arb: ArbResult, ctx: Parameters<Source<ArbItem>['evaluate']>[1]): number {
  const baseAsset = arb.pair.split('-')[0];
  const sellBalance = readBalanceMap(ctx, arb.sellExchange);
  const buyBalance = readBalanceMap(ctx, arb.buyExchange);
  const sellTokens = exchangeAssetBalance(arb.sellExchange, baseAsset, sellBalance);
  const buyQuote = quoteBalance(arb.buyExchange, buyBalance);
  const maxBySell = sellTokens;
  const maxByBuy = arb.buyPrice > 0 ? buyQuote / arb.buyPrice : 0;
  const maxByCapital = MAX_POSITION_USD / arb.buyPrice;
  const size = Math.min(maxBySell, maxByBuy, maxByCapital);
  return isFinite(size) && size > 0 ? size : 0;
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

function buildOpportunity(arb: ArbResult, strategy: ArbStrategyId, size: number): Opportunity | null {
  if (!isFinite(size) || size <= 0) return null;
  const costNow = arb.buyPrice * size;
  if (!isFinite(costNow) || costNow < MIN_EXECUTABLE_USD) return null;
  const projectedReturn = arb.sellPrice * size;
  return {
    id: `crypto-arb:${strategy}:${arb.pair}:${arb.buyExchange}-${arb.sellExchange}`,
    sourceId: 'crypto-arb',
    externalId: `${strategy}:${arb.pair}:${arb.buyExchange}-${arb.sellExchange}`,
    title: `${arb.pair} ${strategy}: ${arb.buyExchange} → ${arb.sellExchange}`,
    category: 'crypto-arbitrage',
    costNow,
    projectedReturn,
    projectedProfit: arb.netPerUnit * size,
    confidence: Math.min(1, arb.spreadPct / 0.5),
    expiresAt: Date.now() + 5_000,
    metadata: { ...arb, size, strategy, inventoryMode: strategy === 'inventory-arb' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function evaluateSpreadArb(item: ArbItem): Opportunity | null {
  const arb = bestArb(item.snapshots);
  if (!arb) return null;
  if (!SUPPORTED_TRADE_EXCHANGES.has(arb.buyExchange) || !SUPPORTED_TRADE_EXCHANGES.has(arb.sellExchange)) {
    return null;
  }
  const size = MAX_POSITION_USD / arb.buyPrice;
  return buildOpportunity(arb, 'spread', size);
}

export function evaluateInventoryArb(item: ArbItem, ctx: Parameters<Source<ArbItem>['evaluate']>[1]): Opportunity | null {
  const arb = bestArb(item.snapshots);
  if (!arb) return null;
  if (!SUPPORTED_TRADE_EXCHANGES.has(arb.buyExchange) || !SUPPORTED_TRADE_EXCHANGES.has(arb.sellExchange)) {
    return null;
  }
  const size = executableInventorySize(arb, ctx);
  return buildOpportunity(arb, 'inventory-arb', size);
}

export function evaluateArbStrategies(item: ArbItem, ctx: Parameters<Source<ArbItem>['evaluate']>[1]): Opportunity[] {
  return [
    evaluateSpreadArb(item),
    evaluateInventoryArb(item, ctx),
  ].filter((opp): opp is Opportunity => opp != null);
}

export const cryptoArbSource: Source<ArbItem> = {
  id: 'crypto-arb',
  pollIntervalMs: 1000, // arb windows close fast
  async poll() {
    const PAIRS = await getActivePairs();
    const items: ArbItem[] = [];
    for (const pair of PAIRS) {
      const snaps = (await Promise.all(FEEDS.map((f) => f.snapshot(pair))))
        .filter((s): s is MarketSnapshot => (
          s != null
          && Number.isFinite(s.bid)
          && Number.isFinite(s.ask)
          && s.bid > 0
          && s.ask > 0
        ));
      if (snaps.length >= 2) {
        items.push({ pair, snapshots: snaps });
      }
    }
    return items;
  },
  evaluate(item, ctx): Opportunity | null {
    return evaluateInventoryArb(item, ctx) ?? evaluateSpreadArb(item);
  },
  async act(opp): Promise<ActionResult> {
    const arb = opp.metadata as unknown as ArbResult & { size: number; strategy?: ArbStrategyId; inventoryMode?: boolean };
    if (arb.strategy !== 'inventory-arb' && !arb.inventoryMode) {
      return { ok: false, message: 'spread strategy is informational only', permanent: true };
    }
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
