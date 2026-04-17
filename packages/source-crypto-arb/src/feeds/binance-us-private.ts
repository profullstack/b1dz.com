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
const SERVER_TIME_TTL_MS = 60_000;
const DEFAULT_RECV_WINDOW_MS = '15000';
const EXCHANGE_INFO_TTL_MS = 5 * 60_000;

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

let serverTimeOffsetMs = 0;
let serverTimeFetchedAt = 0;
let exchangeInfoFetchedAt = 0;
let exchangeInfoBySymbol = new Map<string, BinanceSymbolInfo>();

async function syncServerTime(force = false): Promise<void> {
  if (!force && Date.now() - serverTimeFetchedAt < SERVER_TIME_TTL_MS) return;

  const res = await proxyFetch(`${BASE}/api/v3/time`);
  if (!res.ok) throw new Error(`Binance /api/v3/time: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { serverTime?: number };
  if (!data.serverTime) throw new Error('Binance /api/v3/time: missing serverTime');

  serverTimeOffsetMs = data.serverTime - Date.now();
  serverTimeFetchedAt = Date.now();
}

interface BinanceSymbolFilter {
  filterType: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  minNotional?: string;
}

interface BinanceSymbolInfo {
  symbol: string;
  status: string;
  filters: BinanceSymbolFilter[];
}

interface BinanceExchangeInfo {
  symbols: BinanceSymbolInfo[];
}

export async function hasTradingSymbol(symbol: string): Promise<boolean> {
  await syncExchangeInfo();
  return exchangeInfoBySymbol.get(symbol.toUpperCase())?.status === 'TRADING';
}

export interface BinanceTradingRules {
  minQty: number | null;
  minNotional: number | null;
}

export async function getTradingRules(symbol: string): Promise<BinanceTradingRules | null> {
  await syncExchangeInfo();
  const info = exchangeInfoBySymbol.get(symbol.toUpperCase());
  if (!info) return null;
  const lotSize = info.filters.find((f) => f.filterType === 'LOT_SIZE');
  const minNotionalFilter = info.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
  const minQty = parseFloat(lotSize?.minQty ?? '');
  const minNotional = parseFloat(minNotionalFilter?.minNotional ?? '');
  return {
    minQty: Number.isFinite(minQty) && minQty > 0 ? minQty : null,
    minNotional: Number.isFinite(minNotional) && minNotional > 0 ? minNotional : null,
  };
}

async function syncExchangeInfo(force = false): Promise<void> {
  if (!force && Date.now() - exchangeInfoFetchedAt < EXCHANGE_INFO_TTL_MS && exchangeInfoBySymbol.size > 0) return;
  const res = await proxyFetch(`${BASE}/api/v3/exchangeInfo`);
  if (!res.ok) throw new Error(`Binance /api/v3/exchangeInfo: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as BinanceExchangeInfo;
  const next = new Map<string, BinanceSymbolInfo>();
  for (const symbol of data.symbols ?? []) {
    if (!symbol?.symbol) continue;
    next.set(symbol.symbol.toUpperCase(), symbol);
  }
  exchangeInfoBySymbol = next;
  exchangeInfoFetchedAt = Date.now();
}

function decimalPlaces(value: string): number {
  const trimmed = value.trim();
  if (!trimmed.includes('.')) return 0;
  return trimmed.split('.')[1]!.replace(/0+$/, '').length;
}

function floorToStep(value: number, step: string): number {
  const places = decimalPlaces(step);
  const scale = 10 ** places;
  const scaledValue = Math.floor((value + 1e-12) * scale);
  const scaledStep = Math.max(1, Math.round(parseFloat(step) * scale));
  return Math.floor(scaledValue / scaledStep) * scaledStep / scale;
}

function trimDecimals(value: number, places: number): string {
  return value.toFixed(places).replace(/\.?0+$/, '');
}

async function normalizeOrderParams(opts: OrderOpts): Promise<OrderOpts> {
  await syncExchangeInfo();
  const symbolInfo = exchangeInfoBySymbol.get(opts.symbol.toUpperCase());
  if (!symbolInfo) return opts;

  const lotSize = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE');
  const priceFilter = symbolInfo.filters.find((f) => f.filterType === 'PRICE_FILTER');
  const minNotionalFilter = symbolInfo.filters.find((f) => f.filterType === 'MIN_NOTIONAL');

  let quantity = parseFloat(opts.quantity);
  if (!isFinite(quantity) || quantity <= 0) {
    throw new Error(`Binance ${opts.symbol}: invalid quantity ${opts.quantity}`);
  }

  if (lotSize?.stepSize) {
    quantity = floorToStep(quantity, lotSize.stepSize);
  }
  if (lotSize?.minQty && quantity < parseFloat(lotSize.minQty)) {
    throw new Error(`Binance ${opts.symbol}: quantity ${quantity} below minQty ${lotSize.minQty}`);
  }

  let price = opts.price;
  if (price && priceFilter?.tickSize) {
    const adjustedPrice = floorToStep(parseFloat(price), priceFilter.tickSize);
    price = trimDecimals(adjustedPrice, decimalPlaces(priceFilter.tickSize));
  }

  if (price && minNotionalFilter?.minNotional) {
    const notional = quantity * parseFloat(price);
    if (notional < parseFloat(minNotionalFilter.minNotional)) {
      throw new Error(`Binance ${opts.symbol}: notional $${notional.toFixed(2)} below minNotional ${minNotionalFilter.minNotional}`);
    }
  }

  return {
    ...opts,
    quantity: trimDecimals(quantity, lotSize?.stepSize ? decimalPlaces(lotSize.stepSize) : 8),
    ...(price ? { price } : {}),
  };
}

function binanceTimestamp(): string {
  return Math.round(Date.now() + serverTimeOffsetMs).toString();
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
      await syncServerTime(attempt > 0);

      // Fresh timestamp + signature for each attempt
      const p = { ...params };
      p.timestamp = binanceTimestamp();
      p.recvWindow = DEFAULT_RECV_WINDOW_MS;

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
        if (data.code === -1021) {
          await syncServerTime(true);
        }
        if ((res.status === 429 || res.status >= 500 || data.code === -1003) && attempt < retries - 1) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        if (data.code === -1021 && attempt < retries - 1) {
          lastErr = err;
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
  // Spendable-only view. Locked funds (open orders) are excluded — the arb
  // sizer must not treat them as available, or BUYs fail with -2010.
  const info = await binancePrivate<AccountInfo>('GET', '/api/v3/account');
  const result: Record<string, string> = {};
  for (const b of info.balances) {
    const free = parseFloat(b.free);
    if (free > 0) result[b.asset] = free.toFixed(8);
  }
  return result;
}

export interface BinanceAssetBalance {
  asset: string;
  free: string;
  locked: string;
}

export async function getDetailedBalance(): Promise<BinanceAssetBalance[]> {
  const info = await binancePrivate<AccountInfo>('GET', '/api/v3/account');
  const out: BinanceAssetBalance[] = [];
  for (const b of info.balances) {
    const free = parseFloat(b.free);
    const locked = parseFloat(b.locked);
    if (free + locked <= 0) continue;
    out.push({ asset: b.asset, free: b.free, locked: b.locked });
  }
  return out;
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
  const normalized = await normalizeOrderParams(opts);
  // Safety: estimate cost and refuse if > MAX_POSITION_USD
  const price = normalized.price ? parseFloat(normalized.price) : 0;
  const qty = parseFloat(normalized.quantity);
  if (price > 0 && qty * price > MAX_POSITION_USD) {
    throw new Error(`Order cost $${(qty * price).toFixed(2)} exceeds $${MAX_POSITION_USD} limit`);
  }

  const params: Record<string, string> = {
    symbol: normalized.symbol,
    side: normalized.side,
    type: normalized.type,
    quantity: normalized.quantity,
  };
  if (normalized.type === 'LIMIT') {
    if (!normalized.price) throw new Error('price required for LIMIT orders');
    params.price = normalized.price;
    params.timeInForce = normalized.timeInForce ?? 'GTC';
  }

  return binancePrivate<OrderResult>('POST', '/api/v3/order', params);
}

export async function getOpenOrders(symbol?: string): Promise<OrderResult[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol;
  return binancePrivate<OrderResult[]>('GET', '/api/v3/openOrders', params);
}

export async function cancelOrder(symbol: string, orderId: number): Promise<OrderResult> {
  return binancePrivate<OrderResult>('DELETE', '/api/v3/order', {
    symbol,
    orderId: String(orderId),
  });
}

/** MARKET SELL for the full free balance of `asset` on its USD pair. */
export async function closeHolding(asset: string): Promise<OrderResult> {
  const detailed = await getDetailedBalance();
  const entry = detailed.find((b) => b.asset === asset);
  if (!entry) throw new Error(`Binance: no balance for ${asset}`);
  const free = parseFloat(entry.free);
  if (!isFinite(free) || free <= 0) throw new Error(`Binance: ${asset} free balance is 0 (locked=${entry.locked})`);
  const symbol = `${asset}USD`;
  return placeOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: free.toFixed(8) });
}

export interface BinanceTrade {
  id: number;
  symbol: string;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

export async function getRecentTrades(symbol: string, limit = 100): Promise<BinanceTrade[]> {
  return binancePrivate<BinanceTrade[]>('GET', '/api/v3/myTrades', {
    symbol,
    limit: String(limit),
  });
}
