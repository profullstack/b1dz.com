/**
 * Seed executor — places the actual market-ish buy order on the sell-side
 * exchange when `decideSeed()` returns `{ kind: 'seed' }`. Separated from
 * seeder.ts so the decision logic stays pure + trivially unit-testable.
 *
 * Implementation note: we use an aggressive limit order (buy @ ask price,
 * IOC) rather than a true market order, for two reasons:
 *   1. Existing arb `act()` already uses this pattern — fewer codepaths.
 *   2. Hard ceiling on fill price. A true market order on a thin book can
 *      fill well above the quoted ask; IOC-at-ask either fills within the
 *      quote we saw or cancels.
 */

import { placeOrder as placeKrakenOrder } from './feeds/kraken-private.js';
import { placeOrder as placeBinanceOrder } from './feeds/binance-us-private.js';
import { placeOrder as placeCoinbaseOrder } from './feeds/coinbase-private.js';
import { placeOrder as placeGeminiOrder } from './feeds/gemini-private.js';
import { normalizePair } from './feeds/pairs.js';

export interface SeedOrderRequest {
  exchange: string;      // 'kraken' | 'binance-us' | 'coinbase' | 'gemini'
  pair: string;          // canonical, e.g. 'DOGE-USD'
  sizeUsd: number;       // USD notional to spend
  /** Current ask on the sell-side exchange — used as the IOC limit price. */
  askPriceUsd: number;
}

export interface SeedOrderResult {
  ok: boolean;
  /** USD actually spent (may be less than requested on partial IOC fill). */
  filledCostUsd: number;
  /** Base-asset volume filled. */
  filledVolume: number;
  /** Best-effort exchange order id (varies by venue). */
  orderRef: string;
  /** If `ok === false`, a short human-readable reason. */
  error?: string;
}

export async function placeSeedOrder(req: SeedOrderRequest): Promise<SeedOrderResult> {
  const { exchange, pair, sizeUsd, askPriceUsd } = req;
  if (!Number.isFinite(askPriceUsd) || askPriceUsd <= 0) {
    return { ok: false, filledCostUsd: 0, filledVolume: 0, orderRef: '', error: 'invalid ask price' };
  }
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    return { ok: false, filledCostUsd: 0, filledVolume: 0, orderRef: '', error: 'invalid size' };
  }
  // Add a tiny slippage cushion on the limit price so the order actually
  // crosses the book. 0.25% is enough to clear the top of most CEX books
  // without blowing the arb thesis.
  const limitPrice = askPriceUsd * 1.0025;
  const volume = sizeUsd / limitPrice;

  try {
    if (exchange === 'kraken') {
      const result = await placeKrakenOrder({
        pair: normalizePair(pair, 'kraken'),
        type: 'buy',
        ordertype: 'limit',
        volume: volume.toFixed(8),
        price: limitPrice.toFixed(2),
        timeinforce: 'IOC',
      });
      return {
        ok: true,
        filledCostUsd: volume * limitPrice, // best estimate — Kraken returns txids, fills reconciled later
        filledVolume: volume,
        orderRef: Array.isArray(result.txid) ? result.txid.join(',') : String(result.txid ?? ''),
      };
    }
    if (exchange === 'binance-us') {
      const result = await placeBinanceOrder({
        symbol: normalizePair(pair, 'binance-us'),
        side: 'BUY',
        type: 'LIMIT',
        quantity: volume.toFixed(8),
        price: limitPrice.toFixed(2),
        timeInForce: 'IOC',
      });
      const executedQty = parseFloat(result.executedQty ?? '0') || 0;
      const avgPrice = result.fills?.length
        ? result.fills.reduce((sum, f) => sum + parseFloat(f.price) * parseFloat(f.qty), 0) / Math.max(executedQty, 1e-12)
        : limitPrice;
      return {
        ok: true,
        filledCostUsd: executedQty * avgPrice,
        filledVolume: executedQty,
        orderRef: String(result.orderId ?? ''),
      };
    }
    if (exchange === 'coinbase') {
      const result = await placeCoinbaseOrder({
        productId: pair,
        side: 'BUY',
        size: volume.toFixed(8),
        limitPrice: limitPrice.toFixed(2),
        ioc: true,
      });
      return {
        ok: true,
        filledCostUsd: volume * limitPrice,
        filledVolume: volume,
        orderRef: String((result as { order_id?: string }).order_id ?? ''),
      };
    }
    if (exchange === 'gemini') {
      const result = await placeGeminiOrder({
        symbol: normalizePair(pair, 'gemini'),
        side: 'buy',
        amount: volume.toFixed(8),
        price: limitPrice.toFixed(2),
        options: ['immediate-or-cancel'],
      });
      const executed = parseFloat(result.executed_amount ?? '0') || 0;
      return {
        ok: true,
        filledCostUsd: executed * limitPrice,
        filledVolume: executed,
        orderRef: String(result.order_id ?? ''),
      };
    }
    return {
      ok: false,
      filledCostUsd: 0,
      filledVolume: 0,
      orderRef: '',
      error: `unsupported exchange ${exchange}`,
    };
  } catch (e) {
    return {
      ok: false,
      filledCostUsd: 0,
      filledVolume: 0,
      orderRef: '',
      error: (e as Error).message,
    };
  }
}
