/**
 * Gemini authenticated REST API client.
 *
 * Auth scheme is different from Binance/Kraken/Coinbase:
 *   1. Build a JSON "payload" — must include `request` (the endpoint path)
 *      and `nonce` (strictly increasing integer).
 *   2. Base64-encode the payload.
 *   3. HMAC-SHA384 the base64 payload with the API secret.
 *   4. Send headers: X-GEMINI-APIKEY, X-GEMINI-PAYLOAD (base64),
 *      X-GEMINI-SIGNATURE (hex HMAC). Body must be empty per spec.
 *
 * Env: GEMINI_API_KEY, GEMINI_API_SECRET.
 *
 * Fees: 0.40% taker / 0.20% maker on standard tier (as of 2025-Q3).
 */

import { createHmac } from 'node:crypto';
import { fetchJson } from './http.js';

const BASE = 'https://api.gemini.com';

/** Gemini standard-tier taker fee. */
export const GEMINI_TAKER_FEE = 0.004;

/** Hard ceiling — refuse any order where cost > $100. */
export const MAX_POSITION_USD = 100;

function getKeys() {
  const key = process.env.GEMINI_API_KEY;
  const secret = process.env.GEMINI_API_SECRET;
  if (!key || !secret) throw new Error('GEMINI_API_KEY / GEMINI_API_SECRET missing from env');
  return { key, secret };
}

// Nonce must be strictly increasing per API key. Use ms epoch + counter so
// back-to-back calls never collide even on machines with coarse clocks.
let lastNonce = 0;
function nextNonce(): number {
  const now = Date.now();
  lastNonce = Math.max(now, lastNonce + 1);
  return lastNonce;
}

async function geminiPrivate<T>(
  path: string,
  extraPayload: Record<string, unknown> = {},
  retries = 2,
): Promise<T> {
  const { key, secret } = getKeys();
  const url = `${BASE}${path}`;
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const payload = {
        request: path,
        nonce: nextNonce(),
        ...extraPayload,
      };
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
      const signature = createHmac('sha384', secret).update(payloadB64).digest('hex');

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': '0',
          'X-GEMINI-APIKEY': key,
          'X-GEMINI-PAYLOAD': payloadB64,
          'X-GEMINI-SIGNATURE': signature,
          'Cache-Control': 'no-cache',
        },
      });
      const data = (await res.json()) as T & { result?: string; reason?: string; message?: string };
      if (!res.ok || data.result === 'error') {
        const msg = data.reason || data.message || `HTTP ${res.status}`;
        throw new Error(`Gemini ${path}: ${msg}`);
      }
      return data;
    } catch (e) {
      lastErr = e as Error;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastErr ?? new Error(`Gemini ${path}: all ${retries + 1} attempts failed`);
}

// ─── Public API ───────────────────────────────────────────────

interface GeminiBalance {
  type: string;
  currency: string;
  amount: string;
  available: string;
  availableForWithdrawal: string;
}

export async function getBalance(): Promise<Record<string, string>> {
  // Spendable-only view: report `available`, not `amount`. `amount` includes
  // funds locked in open orders, which would mislead the arb sizer.
  const balances = await geminiPrivate<GeminiBalance[]>('/v1/balances');
  const out: Record<string, string> = {};
  for (const b of balances) {
    const available = parseFloat(b.available);
    if (available > 0) out[b.currency] = available.toFixed(8);
  }
  return out;
}

export interface GeminiAssetBalance {
  asset: string;
  free: string;
  locked: string;
}

export async function getDetailedBalance(): Promise<GeminiAssetBalance[]> {
  const balances = await geminiPrivate<GeminiBalance[]>('/v1/balances');
  const out: GeminiAssetBalance[] = [];
  for (const b of balances) {
    const total = parseFloat(b.amount);
    const available = parseFloat(b.available);
    if (total <= 0) continue;
    const locked = Math.max(0, total - available);
    out.push({ asset: b.currency, free: available.toFixed(8), locked: locked.toFixed(8) });
  }
  return out;
}

export interface OrderOpts {
  symbol: string;         // e.g. 'btcusd'
  side: 'buy' | 'sell';
  amount: string;         // base currency
  price: string;          // required — Gemini has no pure market order
  /** 'immediate-or-cancel' gives market-like behavior with a slippage ceiling. */
  options?: ('immediate-or-cancel' | 'maker-or-cancel' | 'fill-or-kill' | 'auction-only')[];
}

export interface OrderResult {
  order_id: string;
  client_order_id?: string;
  symbol: string;
  side: string;
  type: string;
  price: string;
  original_amount: string;
  executed_amount: string;
  remaining_amount: string;
  avg_execution_price: string;
  is_live: boolean;
  is_cancelled: boolean;
  timestamp: string;
  timestampms: number;
}

export async function placeOrder(opts: OrderOpts): Promise<OrderResult> {
  const price = parseFloat(opts.price);
  const amount = parseFloat(opts.amount);
  if (!(price > 0) || !(amount > 0)) throw new Error(`Gemini: invalid price/amount ${opts.price}/${opts.amount}`);
  if (amount * price > MAX_POSITION_USD) {
    throw new Error(`Gemini order cost $${(amount * price).toFixed(2)} exceeds $${MAX_POSITION_USD} limit`);
  }
  return geminiPrivate<OrderResult>('/v1/order/new', {
    symbol: opts.symbol,
    side: opts.side,
    amount: opts.amount,
    price: opts.price,
    type: 'exchange limit',
    options: opts.options ?? [],
  });
}

export async function cancelOrder(orderId: string | number): Promise<OrderResult> {
  return geminiPrivate<OrderResult>('/v1/order/cancel', { order_id: Number(orderId) });
}

export async function getOpenOrders(): Promise<OrderResult[]> {
  return geminiPrivate<OrderResult[]>('/v1/orders');
}

interface GeminiTicker {
  bid: string;
  ask: string;
  last: string;
}

/** MARKET-like SELL: fetch current bid, submit an immediate-or-cancel limit
 *  2% below bid. Any unfilled portion gets cancelled instead of sitting
 *  as an orphan open order. */
export async function closeHolding(asset: string): Promise<OrderResult> {
  const detailed = await getDetailedBalance();
  const entry = detailed.find((b) => b.asset.toUpperCase() === asset.toUpperCase());
  if (!entry) throw new Error(`Gemini: no balance for ${asset}`);
  const free = parseFloat(entry.free);
  if (!(free > 0)) throw new Error(`Gemini: ${asset} available balance is 0 (locked=${entry.locked})`);
  const symbol = `${asset.toLowerCase()}usd`;
  // Public ticker — no auth needed, no nonce concerns.
  const ticker = await fetchJson<GeminiTicker>(`${BASE}/v1/pubticker/${symbol}`);
  const bid = parseFloat(ticker.bid);
  if (!(bid > 0)) throw new Error(`Gemini ${symbol}: bid unavailable (${ticker.bid})`);
  const limitPrice = (bid * 0.98).toFixed(2);
  return placeOrder({
    symbol,
    side: 'sell',
    amount: free.toFixed(8),
    price: limitPrice,
    options: ['immediate-or-cancel'],
  });
}

/** MARKET-like SELL for an explicit symbol + amount. Useful for exit paths
 *  in the trade-daemon where the caller already decided what to sell. */
export async function placeMarketSell(symbol: string, amount: string): Promise<OrderResult> {
  const ticker = await fetchJson<GeminiTicker>(`${BASE}/v1/pubticker/${symbol}`);
  const bid = parseFloat(ticker.bid);
  if (!(bid > 0)) throw new Error(`Gemini ${symbol}: bid unavailable`);
  return placeOrder({
    symbol,
    side: 'sell',
    amount,
    price: (bid * 0.98).toFixed(2),
    options: ['immediate-or-cancel'],
  });
}

export interface GeminiTrade {
  tid: number;
  symbol: string;
  side: 'Buy' | 'Sell';
  price: string;
  amount: string;
  fee_amount: string;
  fee_currency: string;
  timestampms: number;
}

export async function getRecentTrades(symbol?: string, limit = 50): Promise<GeminiTrade[]> {
  const payload: Record<string, unknown> = { limit_trades: limit };
  if (symbol) payload.symbol = symbol;
  return geminiPrivate<GeminiTrade[]>('/v1/mytrades', payload);
}
