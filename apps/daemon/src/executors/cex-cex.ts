/**
 * CEX↔CEX executor — places an IOC-limit buy on one CEX and an
 * IOC-limit sell on another for the same asset.
 *
 * Handles any of the 12 permutations of {kraken, coinbase, binance-us,
 * gemini}. Market-like behavior via IOC limits at ±2% of mid price.
 *
 * Assumes inventory already holds enough quote on the buy side AND
 * enough base on the sell side (inventory check runs before us in the
 * daemon pipeline).
 */

import type { Executor, ExecutorOutcome } from '@b1dz/trade-daemon';
import type { Opportunity } from '@b1dz/venue-types';
import {
  placeOrder as placeKrakenOrder,
  placeBinanceOrder,
  placeCoinbaseOrder,
  placeGeminiOrder,
  normalizePair,
} from '@b1dz/source-crypto-arb';

const SUPPORTED_VENUES = new Set(['kraken', 'coinbase', 'binance-us', 'gemini']);

export interface CexCexExecutorArgs {
  /** Hard cap USD per leg. Second gate on top of daemon's risk.maxTradeUsd. */
  maxTradeUsd: number;
  /** Slippage buffer in bps for the IOC limit price. Default 200 (2%). */
  slippageBps?: number;
  log?: (msg: string) => void;
}

function abort(reason: string): ExecutorOutcome {
  return { status: 'aborted', resolvedReason: reason, executorRan: false };
}

export class CexCexExecutor implements Executor {
  private readonly maxTradeUsd: number;
  private readonly slippageBps: number;
  private readonly log: (msg: string) => void;

  constructor(args: CexCexExecutorArgs) {
    this.maxTradeUsd = args.maxTradeUsd;
    this.slippageBps = args.slippageBps ?? 200;
    this.log = args.log ?? ((m) => console.log(m));
  }

  canExecute(opp: Opportunity): boolean {
    if (opp.category !== 'cex_cex') return false;
    if (!SUPPORTED_VENUES.has(opp.buyVenue)) return false;
    if (!SUPPORTED_VENUES.has(opp.sellVenue)) return false;
    if (opp.buyVenue === opp.sellVenue) return false;
    return true;
  }

  async execute(opp: Opportunity): Promise<ExecutorOutcome> {
    const sizeUsd = Number.parseFloat(opp.size);
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return abort(`invalid size "${opp.size}"`);
    if (sizeUsd > this.maxTradeUsd) return abort(`size $${sizeUsd.toFixed(2)} > executor cap $${this.maxTradeUsd}`);

    const base = opp.asset.toUpperCase();
    const pair = `${base}-USD`;

    // Prefer the buyQuote.price (what we expect to pay) + sellQuote.price
    // (what we expect to receive). Fall back to 1:1 if the adapter didn't
    // populate them — callers should reject the opp before we see it.
    const rawBuy = opp.buyQuote as unknown as { price?: string | number; amountIn?: string; amountOut?: string };
    const rawSell = opp.sellQuote as unknown as { price?: string | number; amountIn?: string; amountOut?: string };
    const buyPrice = toNum(rawBuy?.price) ?? priceFromQuote(rawBuy);
    const sellPrice = toNum(rawSell?.price) ?? priceFromQuote(rawSell);
    if (!(buyPrice && buyPrice > 0) || !(sellPrice && sellPrice > 0)) {
      return abort(`missing quote price on buy or sell leg (buy=${buyPrice}, sell=${sellPrice})`);
    }

    const quantity = sizeUsd / buyPrice;
    if (!(quantity > 0)) return abort(`zero quantity for size $${sizeUsd} at buy price $${buyPrice}`);

    const slipUp = 1 + this.slippageBps / 10_000;
    const slipDown = 1 - this.slippageBps / 10_000;
    const buyLimit = buyPrice * slipUp;
    const sellLimit = sellPrice * slipDown;

    this.log(`[cex-cex] ${opp.buyVenue}→${opp.sellVenue} ${pair} size=$${sizeUsd.toFixed(2)} qty=${quantity.toFixed(8)} buy@$${buyLimit.toFixed(2)} sell@$${sellLimit.toFixed(2)}`);

    // Place buy leg first. If it fails, no sell leg is attempted.
    let buyOrderId: string | undefined;
    try {
      buyOrderId = await placeBuy(opp.buyVenue, pair, quantity, buyLimit);
    } catch (e) {
      return { status: 'aborted', resolvedReason: `buy leg failed: ${(e as Error).message}`, executorRan: true };
    }

    let sellOrderId: string | undefined;
    try {
      sellOrderId = await placeSell(opp.sellVenue, pair, quantity, sellLimit);
    } catch (e) {
      // Buy filled but sell failed — we're long the asset on buyVenue.
      // Return 'stuck' so the daemon marks the route as risky and the
      // operator can review in activity log. Inventory check + retry
      // will flush the position through the normal trade-daemon path.
      return {
        status: 'stuck',
        resolvedReason: `sell leg failed after buy filled: ${(e as Error).message}`,
        externalId: buyOrderId,
        executorRan: true,
      };
    }

    return {
      status: 'filled',
      resolvedReason: `buy=${buyOrderId} sell=${sellOrderId}`,
      externalId: `${buyOrderId}|${sellOrderId}`,
      executorRan: true,
    };
  }
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function priceFromQuote(q: { amountIn?: string; amountOut?: string } | undefined): number | null {
  const inAmt = toNum(q?.amountIn);
  const outAmt = toNum(q?.amountOut);
  if (!inAmt || !outAmt || inAmt <= 0 || outAmt <= 0) return null;
  return inAmt / outAmt; // quote per base
}

async function placeBuy(venue: string, pair: string, quantity: number, limitPrice: number): Promise<string> {
  if (venue === 'kraken') {
    const krakenPair = pair.replace('-', '').replace('BTC', 'XBT');
    const r = await placeKrakenOrder({
      pair: krakenPair,
      type: 'buy',
      ordertype: 'limit',
      volume: quantity.toFixed(8),
      price: limitPrice.toFixed(2),
      timeinforce: 'IOC',
    });
    return r.txid?.[0] ?? r.descr?.order ?? 'unknown';
  }
  if (venue === 'coinbase') {
    const r = await placeCoinbaseOrder({
      productId: pair,
      side: 'BUY',
      size: quantity.toFixed(8),
      limitPrice: limitPrice.toFixed(2),
      ioc: true,
    });
    return r.order_id ?? 'unknown';
  }
  if (venue === 'binance-us') {
    const symbol = pair.replace('-', '');
    const r = await placeBinanceOrder({
      symbol,
      side: 'BUY',
      type: 'LIMIT',
      quantity: quantity.toFixed(8),
      price: limitPrice.toFixed(2),
      timeInForce: 'IOC',
    });
    return String(r.orderId ?? 'unknown');
  }
  if (venue === 'gemini') {
    const symbol = normalizePair(pair, 'gemini');
    const r = await placeGeminiOrder({
      symbol,
      side: 'buy',
      amount: quantity.toFixed(8),
      price: limitPrice.toFixed(2),
      options: ['immediate-or-cancel'],
    });
    return r.order_id ?? 'unknown';
  }
  throw new Error(`unsupported buy venue: ${venue}`);
}

async function placeSell(venue: string, pair: string, quantity: number, limitPrice: number): Promise<string> {
  if (venue === 'kraken') {
    const krakenPair = pair.replace('-', '').replace('BTC', 'XBT');
    const r = await placeKrakenOrder({
      pair: krakenPair,
      type: 'sell',
      ordertype: 'limit',
      volume: quantity.toFixed(8),
      price: limitPrice.toFixed(2),
      timeinforce: 'IOC',
    });
    return r.txid?.[0] ?? r.descr?.order ?? 'unknown';
  }
  if (venue === 'coinbase') {
    const r = await placeCoinbaseOrder({
      productId: pair,
      side: 'SELL',
      size: quantity.toFixed(8),
      limitPrice: limitPrice.toFixed(2),
      ioc: true,
    });
    return r.order_id ?? 'unknown';
  }
  if (venue === 'binance-us') {
    const symbol = pair.replace('-', '');
    const r = await placeBinanceOrder({
      symbol,
      side: 'SELL',
      type: 'LIMIT',
      quantity: quantity.toFixed(8),
      price: limitPrice.toFixed(2),
      timeInForce: 'IOC',
    });
    return String(r.orderId ?? 'unknown');
  }
  if (venue === 'gemini') {
    const symbol = normalizePair(pair, 'gemini');
    const r = await placeGeminiOrder({
      symbol,
      side: 'sell',
      amount: quantity.toFixed(8),
      price: limitPrice.toFixed(2),
      options: ['immediate-or-cancel'],
    });
    return r.order_id ?? 'unknown';
  }
  throw new Error(`unsupported sell venue: ${venue}`);
}
