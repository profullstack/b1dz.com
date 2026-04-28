/**
 * Places the actual IOC limit sell when `decideLiquidate()` returns
 * `{ kind: 'liquidate', ... }`. Same pattern as the seed executor: we
 * use IOC limit (not market) for a hard price ceiling.
 *
 * The resulting stable proceeds appear in the next-tick balance snapshot,
 * which the seeder then consumes on its next pass. We do NOT chain
 * liquidation → seed in the same tick: keeping them as two separate
 * ticks means the real balance is re-fetched from the exchange between
 * them, so we never guess at the post-sell balance.
 */

import { placeOrder as placeKrakenOrder } from './feeds/kraken-private.js';
import { placeOrder as placeBinanceOrder } from './feeds/binance-us-private.js';
import { placeOrder as placeCoinbaseOrder } from './feeds/coinbase-private.js';
import { placeOrder as placeGeminiOrder } from './feeds/gemini-private.js';
import { normalizePair } from './feeds/pairs.js';

export interface LiquidateOrderRequest {
  exchange: string;        // 'kraken' | 'binance-us' | 'coinbase' | 'gemini'
  asset: string;           // canonical base asset, e.g. 'ADA'
  sellVolume: number;      // base units to sell
  limitPriceUsd: number;   // IOC limit price
}

export interface LiquidateOrderResult {
  ok: boolean;
  filledVolume: number;
  filledUsd: number;
  orderRef: string;
  error?: string;
}

export async function placeLiquidateOrder(req: LiquidateOrderRequest): Promise<LiquidateOrderResult> {
  const { exchange, asset, sellVolume, limitPriceUsd } = req;
  if (!Number.isFinite(sellVolume) || sellVolume <= 0) {
    return { ok: false, filledVolume: 0, filledUsd: 0, orderRef: '', error: 'invalid volume' };
  }
  if (!Number.isFinite(limitPriceUsd) || limitPriceUsd <= 0) {
    return { ok: false, filledVolume: 0, filledUsd: 0, orderRef: '', error: 'invalid price' };
  }
  // The canonical pair we're trading is `${asset}-USD`. Each venue adapter
  // takes care of mapping it to its own symbol (e.g. binance-us ADAUSD,
  // kraken ADAUSD / ADAZUSD, coinbase ADA-USD, gemini adausd).
  const pair = `${asset}-USD`;

  try {
    if (exchange === 'kraken') {
      const result = await placeKrakenOrder({
        pair: normalizePair(pair, 'kraken'),
        type: 'sell',
        ordertype: 'limit',
        volume: sellVolume.toFixed(8),
        price: limitPriceUsd.toFixed(4),
        timeinforce: 'IOC',
      });
      return {
        ok: true,
        filledVolume: sellVolume,
        filledUsd: sellVolume * limitPriceUsd,
        orderRef: Array.isArray(result.txid) ? result.txid.join(',') : String(result.txid ?? ''),
      };
    }
    if (exchange === 'binance-us') {
      const result = await placeBinanceOrder({
        symbol: normalizePair(pair, 'binance-us'),
        side: 'SELL',
        type: 'LIMIT',
        quantity: sellVolume.toFixed(8),
        price: limitPriceUsd.toFixed(4),
        timeInForce: 'IOC',
      });
      const executedQty = parseFloat(result.executedQty ?? '0') || 0;
      const avgPrice = result.fills?.length
        ? result.fills.reduce((sum, f) => sum + parseFloat(f.price) * parseFloat(f.qty), 0) / Math.max(executedQty, 1e-12)
        : limitPriceUsd;
      return {
        ok: true,
        filledVolume: executedQty,
        filledUsd: executedQty * avgPrice,
        orderRef: String(result.orderId ?? ''),
      };
    }
    if (exchange === 'coinbase') {
      const result = await placeCoinbaseOrder({
        productId: pair,
        side: 'SELL',
        size: sellVolume.toFixed(8),
        limitPrice: limitPriceUsd.toFixed(4),
        ioc: true,
      });
      return {
        ok: true,
        filledVolume: sellVolume,
        filledUsd: sellVolume * limitPriceUsd,
        orderRef: String((result as { order_id?: string }).order_id ?? ''),
      };
    }
    if (exchange === 'gemini') {
      const result = await placeGeminiOrder({
        symbol: normalizePair(pair, 'gemini'),
        side: 'sell',
        amount: sellVolume.toFixed(8),
        price: limitPriceUsd.toFixed(4),
        options: ['immediate-or-cancel'],
      });
      const executed = parseFloat(result.executed_amount ?? '0') || 0;
      return {
        ok: true,
        filledVolume: executed,
        filledUsd: executed * limitPriceUsd,
        orderRef: String(result.order_id ?? ''),
      };
    }
    return {
      ok: false,
      filledVolume: 0,
      filledUsd: 0,
      orderRef: '',
      error: `unsupported exchange ${exchange}`,
    };
  } catch (e) {
    return {
      ok: false,
      filledVolume: 0,
      filledUsd: 0,
      orderRef: '',
      error: (e as Error).message,
    };
  }
}
