/**
 * Kraken authenticated (private) REST API client.
 *
 * Uses HMAC-SHA512 signing per Kraken's spec:
 *   API-Sign = HMAC-SHA512(path + SHA256(nonce + postdata), base64decode(secret))
 *
 * Reads KRAKEN_API_KEY and KRAKEN_API_SECRET from env.
 */

import { createHash, createHmac } from 'node:crypto';

const BASE = 'https://api.kraken.com';

/** Hard ceiling — refuse any order where cost > $100. */
export const MAX_POSITION_USD = 100;

/** Kraken taker fee (0.26%). */
export const KRAKEN_TAKER_FEE = 0.0026;

// Monotonic nonce: microsecond timestamp, guaranteed to increase even
// when multiple requests fire in the same millisecond.
let lastNonce = 0;
function nextNonce(): string {
  const now = Date.now() * 1000; // microseconds
  lastNonce = now > lastNonce ? now : lastNonce + 1;
  return lastNonce.toString();
}

function getKeys() {
  const key = process.env.KRAKEN_API_KEY;
  const secret = process.env.KRAKEN_API_SECRET;
  if (!key || !secret) throw new Error('KRAKEN_API_KEY / KRAKEN_API_SECRET missing from env');
  return { key, secret };
}

function sign(path: string, postData: string, secret: string): string {
  const hash = createHash('sha256')
    .update(postData)
    .digest();
  const hmac = createHmac('sha512', Buffer.from(secret, 'base64'))
    .update(Buffer.concat([Buffer.from(path), hash]))
    .digest('base64');
  return hmac;
}

async function krakenPrivate<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { key, secret } = getKeys();
  const nonce = nextNonce();
  params.nonce = nonce;

  const body = new URLSearchParams(params).toString();
  const signature = sign(path, nonce + body, secret);

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'API-Key': key,
      'API-Sign': signature,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) throw new Error(`Kraken ${path}: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { error: string[]; result: T };
  if (data.error?.length) throw new Error(`Kraken ${path}: ${data.error.join(', ')}`);
  return data.result;
}

// ─── Public API ───────────────────────────────────────────────

export async function getBalance(): Promise<Record<string, string>> {
  return krakenPrivate<Record<string, string>>('/0/private/Balance');
}

export interface OrderOpts {
  pair: string;          // e.g. 'XBTUSD'
  type: 'buy' | 'sell';
  ordertype: 'market' | 'limit';
  volume: string;        // quantity in base currency
  price?: string;        // required for limit orders
}

export interface OrderResult {
  descr: { order: string };
  txid: string[];
}

export async function placeOrder(opts: OrderOpts): Promise<OrderResult> {
  // Safety: estimate cost and refuse if > MAX_POSITION_USD
  const price = opts.price ? parseFloat(opts.price) : 0;
  const vol = parseFloat(opts.volume);
  if (price > 0 && vol * price > MAX_POSITION_USD) {
    throw new Error(`Order cost $${(vol * price).toFixed(2)} exceeds $${MAX_POSITION_USD} limit`);
  }

  const params: Record<string, string> = {
    pair: opts.pair,
    type: opts.type,
    ordertype: opts.ordertype,
    volume: opts.volume,
  };
  if (opts.price) params.price = opts.price;

  return krakenPrivate<OrderResult>('/0/private/AddOrder', params);
}

export interface OpenOrder {
  descr: { pair: string; type: string; ordertype: string; price: string; order: string };
  vol: string;
  vol_exec: string;
  status: string;
}

export async function getOpenOrders(): Promise<Record<string, OpenOrder>> {
  const result = await krakenPrivate<{ open: Record<string, OpenOrder> }>('/0/private/OpenOrders');
  return result.open;
}

export interface TradeEntry {
  pair: string;
  type: string;
  ordertype: string;
  price: string;
  cost: string;
  fee: string;
  vol: string;
  time: number;
}

export async function getTradeHistory(): Promise<Record<string, TradeEntry>> {
  const result = await krakenPrivate<{ trades: Record<string, TradeEntry> }>('/0/private/TradesHistory');
  return result.trades;
}
