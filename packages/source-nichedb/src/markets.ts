/**
 * The `markets` collection's `history` kind: one item per US equity symbol
 * carrying its last 400 daily bars, oldest first, per niche-db docs/markets.md.
 *
 *   data.bars = [[ 'YYYY-MM-DD', open, high, low, close, volume, vwap ], ...]
 */

import type { NichedbClient, NichedbItem } from './client.js';

export const MARKETS_COLLECTION = 'markets';

/** One bar as nichedb stores it: day, open, high, low, close, volume, vwap (null when the feed sent none). */
export type HistoryBarTuple = [string, number, number, number, number, number, (number | null)?];

export interface HistoryData {
  symbol: string;
  timeframe: '1Day' | string;
  feed: 'iex' | 'sip' | string;
  adjustment: string;
  bars: HistoryBarTuple[];
  first: string;
  last: string;
  count: number;
}

export type HistoryItem = NichedbItem<HistoryData>;

/** A daily bar in the shape b1dz's backtesters consume. `ts` is midnight UTC of the bar's day. */
export interface DailyBar {
  ts: number;
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** nichedb keeps at most this many bars per symbol; a longer request cannot be served from it. */
export const HISTORY_MAX_BARS = 400;
/** A window whose last bar is older than this is stale (long weekend plus a holiday still fits). */
export const HISTORY_MAX_AGE_DAYS = 5;
/** The Yahoo path pads each end of the window by a week; keep the same slack. */
const WINDOW_PAD_MS = 7 * DAY_MS;

/** nichedb tags symbols lower-case in Alpaca's spelling (`brk.b`); b1dz and Yahoo write `BRK-B`. */
export function historySymbolTag(symbol: string): string {
  return `symbol:${symbol.trim().toLowerCase().replace(/-/g, '.')}`;
}

/** Midnight UTC of a `YYYY-MM-DD` day, or null when the string is not one. */
export function dayToUtcMs(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}

/** Turn a history item's tuples into bars, dropping malformed rows, oldest first. */
export function barsFromHistory(data: HistoryData | null | undefined): DailyBar[] {
  const out: DailyBar[] = [];
  for (const tuple of data?.bars ?? []) {
    if (!Array.isArray(tuple) || tuple.length < 6) continue;
    const [day, open, high, low, close, volume, vwap] = tuple;
    const ts = typeof day === 'string' ? dayToUtcMs(day) : null;
    if (ts === null) continue;
    if (![open, high, low, close].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    out.push({
      ts,
      day,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: typeof volume === 'number' && Number.isFinite(volume) ? volume : 0,
      vwap: typeof vwap === 'number' && Number.isFinite(vwap) ? vwap : null,
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export type HistoryMiss =
  | 'window-too-long' // more than 400 days asked for; nichedb holds at most 400 bars
  | 'missing' // no history item for the symbol
  | 'empty' // an item with no usable bars
  | 'stale' // last bar older than HISTORY_MAX_AGE_DAYS
  | 'short'; // the window does not reach back to the requested start

export type HistoryResult = { ok: true; bars: DailyBar[]; item: HistoryItem } | { ok: false; reason: HistoryMiss; item?: HistoryItem };

export interface HistoryOptions {
  /** "Now" for the staleness check; defaults to Date.now(). */
  now?: number;
  maxAgeDays?: number;
}

/**
 * Decide whether a history item can serve a `[startMs, endMs]` request and,
 * if so, return its bars for that window (padded a week either side, as the
 * Yahoo path pads). Pure: the caller fetches the item.
 */
export function historyWindow(item: HistoryItem | null | undefined, startMs: number, endMs: number, opts: HistoryOptions = {}): HistoryResult {
  const now = opts.now ?? Date.now();
  const maxAgeMs = (opts.maxAgeDays ?? HISTORY_MAX_AGE_DAYS) * DAY_MS;
  if (endMs - startMs > HISTORY_MAX_BARS * DAY_MS) return { ok: false, reason: 'window-too-long' };
  if (!item) return { ok: false, reason: 'missing' };
  const all = barsFromHistory(item.data);
  if (all.length === 0) return { ok: false, reason: 'empty', item };
  const last = all[all.length - 1]!;
  // `last.ts` is midnight of the bar's day: the bar is stale once its day is more than maxAgeDays before now's day.
  if (now - last.ts >= maxAgeMs + DAY_MS) return { ok: false, reason: 'stale', item };
  const first = all[0]!;
  // A symbol first seen recently has a window that starts after the request; do not truncate silently.
  if (first.ts > startMs + WINDOW_PAD_MS) return { ok: false, reason: 'short', item };
  const lo = startMs - WINDOW_PAD_MS;
  const hi = endMs + WINDOW_PAD_MS;
  return { ok: true, bars: all.filter((b) => b.ts >= lo && b.ts <= hi), item };
}

/** One request: the history item for a symbol, or null when nichedb has none. */
export async function fetchHistoryItem(client: NichedbClient, symbol: string): Promise<HistoryItem | null> {
  const rows = await client.items<HistoryData>({
    collection: MARKETS_COLLECTION,
    kind: 'history',
    tags: [historySymbolTag(symbol)],
    limit: 1,
  });
  return rows[0] ?? null;
}

/**
 * Daily bars for a symbol from nichedb, or a reason it cannot serve them.
 * Makes no request when the window is longer than nichedb can hold.
 */
export async function fetchDailyBars(
  client: NichedbClient,
  symbol: string,
  startMs: number,
  endMs: number,
  opts: HistoryOptions = {},
): Promise<HistoryResult> {
  if (endMs - startMs > HISTORY_MAX_BARS * DAY_MS) return { ok: false, reason: 'window-too-long' };
  const item = await fetchHistoryItem(client, symbol);
  return historyWindow(item, startMs, endMs, opts);
}
