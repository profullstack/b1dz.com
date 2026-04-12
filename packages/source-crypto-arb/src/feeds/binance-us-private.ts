/**
 * Binance.US authenticated REST API client.
 *
 * Uses HMAC-SHA256 signing:
 *   signature = HMAC-SHA256(queryString, secret)
 *   Appended as &signature= to the query string.
 *
 * Reads BINANCE_US_API_KEY and BINANCE_US_API_SECRET from env.
 */

import { createHmac } from 'node:crypto';
import { proxyFetch } from './proxy.js';

const BASE = 'https://api.binance.us';

/** Hard ceiling — refuse any order where cost > $100. */
export const MAX_POSITION_USD = 100;

/** Binance.US taker fee (0.10%). */
export const BINANCE_TAKER_FEE = 0.001;

function getKeys() {
  const key = process.env.BINANCE_US_API_KEY;
  const secret = process.env.BINANCE_US_API_SECRET;
  if (!key || !secret) throw new Error('BINANCE_US_API_KEY / BINANCE_US_API_SECRET missing from env');
  return { key, secret };
}

function sign(queryString: string, secret: string): string {
  return createHmac('sha256', secret).update(queryString).digest('hex');
}

async function binancePrivate<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string> = {},
  retries = 3,
): Promise<T> {
  const { key, secret } = getKeys();
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Fresh timestamp + signature for each attempt
      const p = { ...params };
      p.timestamp = (Date.now() - 1000).toString();
      p.recvWindow = '10000';

      const qs = new URLSearchParams(p).toString();
      const signature = sign(qs, secret);
      const fullQs = `${qs}&signature=${signature}`;

      const url = method === 'GET' || method === 'DELETE'
        ? `${BASE}${path}?${fullQs}`
        : `${BASE}${path}`;

      const res = await proxyFetch(url, {
        method,
        headers: {
          'X-MBX-APIKEY': key,
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(method === 'POST' ? { body: fullQs } : {}),
      });

      const data = (await res.json()) as T & { code?: number; msg?: string };
      if (!res.ok || data.code) {
        const err = new Error(`Binance ${path}: ${data.code ?? res.status} ${data.msg ?? res.statusText}`);
        if ((res.status === 429 || res.status >= 500 || data.code === -1003) && attempt < retries - 1) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        throw err;
      }
      return data;
    } catch (e) {
      lastErr = e as Error;
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastErr ?? new Error(`Binance ${path}: all ${retries} attempts failed`);
}

// ─── Public API ───────────────────────────────────────────────

interface BalanceEntry {
  asset: string;
  free: string;
  locked: string;
}

interface AccountInfo {
  balances: BalanceEntry[];
}

export async function getBalance(): Promise<Record<string, string>> {
  const info = await binancePrivate<AccountInfo>('GET', '/api/v3/account');
  const result: Record<string, string> = {};
  for (const b of info.balances) {
    const free = parseFloat(b.free);
    if (free > 0) result[b.asset] = b.free;
  }
  return result;
}

export interface OrderOpts {
  symbol: string;        // e.g. 'BTCUSD'
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: string;
  price?: string;        // required for LIMIT
  timeInForce?: string;  // 'GTC' for LIMIT orders
}

export interface OrderResult {
  orderId: number;
  symbol: string;
  status: string;
  side: string;
  type: string;
  price: string;
  executedQty: string;
  fills: { price: string; qty: string; commission: string }[];
}

export async function placeOrder(opts: OrderOpts): Promise<OrderResult> {
  // Safety: estimate cost and refuse if > MAX_POSITION_USD
  const price = opts.price ? parseFloat(opts.price) : 0;
  const qty = parseFloat(opts.quantity);
  if (price > 0 && qty * price > MAX_POSITION_USD) {
    throw new Error(`Order cost $${(qty * price).toFixed(2)} exceeds $${MAX_POSITION_USD} limit`);
  }

  const params: Record<string, string> = {
    symbol: opts.symbol,
    side: opts.side,
    type: opts.type,
    quantity: opts.quantity,
  };
  if (opts.type === 'LIMIT') {
    if (!opts.price) throw new Error('price required for LIMIT orders');
    params.price = opts.price;
    params.timeInForce = opts.timeInForce ?? 'GTC';
  }

  return binancePrivate<OrderResult>('POST', '/api/v3/order', params);
}

export async function getOpenOrders(symbol?: string): Promise<OrderResult[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol;
  return binancePrivate<OrderResult[]>('GET', '/api/v3/openOrders', params);
}
