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
const ASSET_PAIR_CACHE_TTL_MS = 5 * 60_000;
const KRAKEN_LOCKOUT_BASE_MS = 15 * 60_000;
const KRAKEN_LOCKOUT_MAX_MS = 60 * 60_000;

/** Hard ceiling — refuse any order where cost > $100. */
export const MAX_POSITION_USD = 100;

/** Kraken taker fee (0.26%). */
export const KRAKEN_TAKER_FEE = 0.0026;
let assetPairsFetchedAt = 0;
let tradablePairs = new Set<string>();
let assetPairMeta = new Map<string, { altname?: string; status?: string; ordermin?: string }>();
let privateBlockedUntil = 0;
let privateLockoutBackoffMs = KRAKEN_LOCKOUT_BASE_MS;

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

// Mutex: serialize all Kraken private API calls so nonces never race.
let lock: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lock;
  let resolve: () => void;
  lock = new Promise((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

async function krakenPrivate<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  return withLock(async () => {
    if (Date.now() < privateBlockedUntil) {
      const remainingSec = Math.ceil((privateBlockedUntil - Date.now()) / 1000);
      throw new Error(`Kraken ${path}: EGeneral:Temporary lockout (${remainingSec}s remaining)`);
    }

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
    if (data.error?.length) {
      if (data.error.some((msg) => msg.includes('Temporary lockout'))) {
        privateBlockedUntil = Date.now() + privateLockoutBackoffMs;
        privateLockoutBackoffMs = Math.min(privateLockoutBackoffMs * 2, KRAKEN_LOCKOUT_MAX_MS);
      }
      throw new Error(`Kraken ${path}: ${data.error.join(', ')}`);
    }
    privateBlockedUntil = 0;
    privateLockoutBackoffMs = KRAKEN_LOCKOUT_BASE_MS;
    return data.result;
  });
}

// ─── Public API ───────────────────────────────────────────────

async function syncAssetPairs(force = false): Promise<void> {
  if (!force && Date.now() - assetPairsFetchedAt < ASSET_PAIR_CACHE_TTL_MS && tradablePairs.size > 0) return;
  const res = await fetch(`${BASE}/0/public/AssetPairs`);
  if (!res.ok) throw new Error(`Kraken /0/public/AssetPairs: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { error: string[]; result: Record<string, { altname?: string; status?: string; ordermin?: string }> };
  if (data.error?.length) throw new Error(`Kraken /0/public/AssetPairs: ${data.error.join(', ')}`);
  assetPairMeta = new Map(Object.entries(data.result ?? {}));
  tradablePairs = new Set(
    Object.entries(data.result ?? {})
      .filter(([, pair]) => !pair.status || pair.status === 'online')
      .flatMap(([id, pair]) => [id, pair.altname].filter((v): v is string => !!v)),
  );
  assetPairsFetchedAt = Date.now();
}

export async function hasTradingPair(pair: string): Promise<boolean> {
  await syncAssetPairs();
  return tradablePairs.has(pair);
}

export async function getPairMinVolume(pair: string): Promise<number | null> {
  await syncAssetPairs();
  for (const [id, meta] of assetPairMeta.entries()) {
    if (id === pair || meta.altname === pair) {
      const minVolume = parseFloat(meta.ordermin ?? '');
      return Number.isFinite(minVolume) && minVolume > 0 ? minVolume : null;
    }
  }
  return null;
}

export async function getBalance(): Promise<Record<string, string>> {
  return krakenPrivate<Record<string, string>>('/0/private/Balance');
}

export interface OrderOpts {
  pair: string;          // e.g. 'XBTUSD'
  type: 'buy' | 'sell';
  ordertype: 'market' | 'limit';
  volume: string;        // quantity in base currency
  price?: string;        // required for limit orders
  leverage?: string;     // e.g. '2:1' — only if MARGIN_TRADING=true
}

export interface OrderResult {
  descr: { order: string };
  txid: string[];
}

export async function placeOrder(opts: OrderOpts): Promise<OrderResult> {
  const minVolume = await getPairMinVolume(opts.pair);
  const vol = parseFloat(opts.volume);
  if (minVolume != null && Number.isFinite(vol) && vol < minVolume) {
    throw new Error(`Kraken ${opts.pair}: volume ${vol} below minimum ${minVolume}`);
  }

  // Safety: estimate cost and refuse if > MAX_POSITION_USD
  const price = opts.price ? parseFloat(opts.price) : 0;
  if (price > 0 && vol * price > MAX_POSITION_USD) {
    throw new Error(`Order cost $${(vol * price).toFixed(2)} exceeds $${MAX_POSITION_USD} limit`);
  }

  // Block margin trading unless explicitly enabled
  if (opts.leverage) {
    if (process.env.MARGIN_TRADING !== 'true') {
      throw new Error('Margin trading is disabled. Set MARGIN_TRADING=true in .env to enable.');
    }
  }

  const params: Record<string, string> = {
    pair: opts.pair,
    type: opts.type,
    ordertype: opts.ordertype,
    volume: opts.volume,
  };
  if (opts.price) params.price = opts.price;
  if (opts.leverage && process.env.MARGIN_TRADING === 'true') params.leverage = opts.leverage;

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

export async function cancelOrder(txid: string): Promise<{ count: number }> {
  return krakenPrivate<{ count: number }>('/0/private/CancelOrder', { txid });
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
