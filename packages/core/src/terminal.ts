/**
 * Shared rules for the research terminal's watchlist and manual order ticket.
 *
 * Pure and dependency-free: the browser, the web API, the daemon and the CLI
 * all validate with the same code, so an order the ticket accepts is an order
 * the daemon accepts.
 */
import type { BrokerOrderArgs } from './plugins.js';

// ---- watchlist -------------------------------------------------------------

export const WATCHLIST_MAX = 100;
export const DEFAULT_TERMINAL_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'SPY', 'QQQ', 'BTC-USD'];

/** Tickers as the research cards take them: AAPL, BRK.B, BTC-USD, ^GSPC, EURUSD=X. */
const WATCH_SYMBOL = /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/;

/** Upper-cased symbol, or null when it is not something a quote source could know. */
export function normalizeWatchSymbol(input: string): string | null {
  const s = input.trim().toUpperCase();
  return WATCH_SYMBOL.test(s) ? s : null;
}

/** A clean, de-duplicated list from "AAPL, msft tsla" or an array. Bad entries are dropped. */
export function parseWatchlist(input: unknown, max = WATCHLIST_MAX): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const s = normalizeWatchSymbol(item);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function serializeWatchlist(symbols: string[]): string {
  return parseWatchlist(symbols).join(',');
}

/** Add (front of the list) or remove one symbol. Returns the same array when nothing changes. */
export function editWatchlist(list: string[], action: 'add' | 'remove', symbol: string): string[] {
  const s = normalizeWatchSymbol(symbol);
  if (!s) return list;
  if (action === 'add') return list.includes(s) || list.length >= WATCHLIST_MAX ? list : [...list, s];
  return list.includes(s) ? list.filter((x) => x !== s) : list;
}

// ---- manual orders ---------------------------------------------------------

/** Largest live order the ticket sends unless the user raises TERMINAL_MAX_ORDER_USD. */
export const DEFAULT_TERMINAL_MAX_ORDER_USD = 10_000;

/** What a broker can trade: US stock and ETF tickers (BRK.B style classes allowed). */
const ORDER_SYMBOL = /^[A-Z][A-Z0-9]{0,5}([.-][A-Z]{1,2})?$/;

export type ManualOrderParse = { ok: true; order: BrokerOrderArgs } | { ok: false; error: string };

function positive(v: unknown): number | null {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(x) && x > 0 ? x : null;
}

/**
 * Validate an order ticket. Exactly one of qty / notionalUsd; a limit order
 * needs a limit price; extended hours need a limit order (no broker fills a
 * market order outside regular hours).
 */
export function parseManualOrder(input: unknown): ManualOrderParse {
  const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const symbol = typeof b.symbol === 'string' ? b.symbol.trim().toUpperCase() : '';
  if (!ORDER_SYMBOL.test(symbol)) return { ok: false, error: 'symbol must be a U.S. stock or ETF ticker, e.g. AAPL' };
  const side = b.side === 'buy' || b.side === 'sell' ? b.side : null;
  if (!side) return { ok: false, error: 'side must be buy or sell' };
  const type = b.type === 'limit' ? 'limit' : b.type === 'market' || b.type === undefined ? 'market' : null;
  if (!type) return { ok: false, error: 'type must be market or limit' };

  const hasQty = b.qty !== undefined && b.qty !== null && b.qty !== '';
  const hasNotional = b.notionalUsd !== undefined && b.notionalUsd !== null && b.notionalUsd !== '';
  if (hasQty === hasNotional) return { ok: false, error: 'give either a share quantity or a dollar amount, not both' };
  const qty = hasQty ? positive(b.qty) : null;
  const notionalUsd = hasNotional ? positive(b.notionalUsd) : null;
  if (hasQty && (qty === null || qty > 1_000_000)) return { ok: false, error: 'quantity must be a positive number of shares' };
  if (hasNotional && (notionalUsd === null || notionalUsd < 1)) return { ok: false, error: 'dollar amount must be at least $1' };

  let limitPrice: number | undefined;
  if (type === 'limit') {
    const p = positive(b.limitPrice);
    if (p === null) return { ok: false, error: 'a limit order needs a limit price' };
    limitPrice = p;
    if (hasNotional) return { ok: false, error: 'a limit order is sized in shares, not dollars' };
  }
  const tif = b.tif === 'gtc' || b.tif === 'ioc' ? b.tif : b.tif === 'day' || b.tif === undefined ? 'day' : null;
  if (!tif) return { ok: false, error: 'time in force must be day, gtc or ioc' };
  const extendedHours = b.extendedHours === true;
  if (extendedHours && type !== 'limit') return { ok: false, error: 'extended hours need a limit order' };

  return {
    ok: true,
    order: {
      symbol,
      side,
      type,
      tif,
      ...(qty !== null ? { qty } : {}),
      ...(notionalUsd !== null ? { notionalUsd } : {}),
      ...(limitPrice !== undefined ? { limitPrice } : {}),
      ...(extendedHours ? { extendedHours: true } : {}),
    },
  };
}

/** Dollar size of an order at `price` (the limit price wins over the quote). 0 when unknowable. */
export function estimateOrderUsd(order: BrokerOrderArgs, price: number): number {
  if (order.notionalUsd != null) return order.notionalUsd;
  const px = order.limitPrice ?? price;
  return order.qty != null && Number.isFinite(px) && px > 0 ? order.qty * px : 0;
}

/** "Buy 5 AAPL at market, day" for the confirm step and the CLI. */
export function describeOrder(order: BrokerOrderArgs): string {
  const size = order.notionalUsd != null ? `$${order.notionalUsd.toLocaleString('en-US')} of` : `${order.qty}`;
  const px = order.type === 'limit' ? `limit $${order.limitPrice}` : 'at market';
  return `${order.side === 'buy' ? 'Buy' : 'Sell'} ${size} ${order.symbol} ${px}, ${order.tif.toUpperCase()}${order.extendedHours ? ', extended hours' : ''}`;
}
