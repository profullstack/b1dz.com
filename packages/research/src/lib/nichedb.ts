/**
 * Daily bars for U.S. stocks and ETFs from nichedb.dev's `markets` collection:
 * the same Alpaca-fed history the b1dz console and backtester read
 * (see @b1dz/source-nichedb). Public and keyless.
 *
 *   GET /api/v1/items?collection=markets&kind=history&tags=symbol:aapl&limit=1
 *   item.data.bars = [[ 'YYYY-MM-DD', open, high, low, close, volume, vwap ], ...]
 *
 * About 400 daily bars a symbol, split adjusted, from the IEX feed.
 */
import { SourceError, type Ctx } from '../types.js';

export const NICHEDB = 'NicheDB (Alpaca IEX)';
const BASE = 'https://nichedb.dev/api/v1/items';
const DAY = 86_400_000;
/** A history whose last bar is older than this is stale (a long weekend plus a holiday still fits). */
const MAX_AGE_DAYS = 5;

export interface NichedbBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

/** nichedb tags symbols lower-case in Alpaca's spelling: BRK-B is `brk.b`. */
export function nichedbTag(symbol: string): string {
  return `symbol:${symbol.trim().toLowerCase().replace(/-/g, '.')}`;
}

/** The first item's bar tuples -> bars, oldest first. Malformed rows are dropped. */
export function parseNichedbHistory(body: unknown): NichedbBar[] {
  const item = (body as { items?: { data?: { bars?: unknown[] } }[] } | null)?.items?.[0];
  const out: NichedbBar[] = [];
  for (const row of item?.data?.bars ?? []) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(row[0]));
    const [o, h, l, c] = row.slice(1, 5).map(Number);
    if (!m || ![o, h, l, c].every(Number.isFinite)) continue;
    const v = Number(row[5]);
    out.push({ t: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), o, h, l, c, v: Number.isFinite(v) ? v : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Throws when nichedb has no history for the symbol or the history is stale. */
export async function nichedbBars(ctx: Ctx, symbol: string): Promise<NichedbBar[]> {
  const url = `${BASE}?collection=markets&kind=history&tags=${encodeURIComponent(nichedbTag(symbol))}&limit=1`;
  const bars = parseNichedbHistory(await ctx.http.json<unknown>(url, { source: NICHEDB, ttl: 1800 }));
  if (!bars.length) throw new SourceError(NICHEDB, `no history for ${symbol}`);
  if (ctx.now().getTime() - bars[bars.length - 1].t > MAX_AGE_DAYS * DAY) throw new SourceError(NICHEDB, `history for ${symbol} is stale`);
  return bars;
}

export const NICHEDB_NEWS = 'NicheDB market news';

export interface NichedbHeadline {
  /** Published time, ms since epoch; null when the item has none. */
  t: number | null;
  title: string;
  /** Site the story is on, without "www." */
  publisher: string;
  url: string;
  symbols: string[];
}

/** `kind=market-news` items -> headlines, newest first. Items without a usable http(s) link are dropped. */
export function parseNichedbNews(body: unknown): NichedbHeadline[] {
  const items = (body as { items?: { title?: string; url?: string | null; published_at?: string | null; data?: { symbols?: unknown } }[] } | null)?.items;
  const out: NichedbHeadline[] = [];
  for (const it of Array.isArray(items) ? items : []) {
    const title = (it.title ?? '').trim();
    let host = '';
    try {
      const u = new URL(it.url ?? '');
      if (u.protocol === 'https:' || u.protocol === 'http:') host = u.hostname.replace(/^www\./, '');
    } catch {
      /* not a link */
    }
    if (!title || !host) continue;
    const t = Date.parse(it.published_at ?? '');
    const symbols = Array.isArray(it.data?.symbols) ? (it.data?.symbols as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    out.push({ t: Number.isNaN(t) ? null : t, title, publisher: host, url: it.url as string, symbols });
  }
  return out.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
}

/**
 * Headlines tagged to a symbol (or the latest for the whole market when no
 * symbol is given), with links to the original publisher. It comes from the
 * same NicheDB `markets` collection the b1dz console reads for prices, and
 * replaced Nasdaq's article pages, which Nasdaq's edge refuses to serve to
 * many networks.
 */
export async function nichedbNews(ctx: Ctx, symbol?: string, limit = 25): Promise<NichedbHeadline[]> {
  const tag = symbol ? `&tags=${encodeURIComponent(symbol.trim().toLowerCase().replace(/-/g, '.'))}` : '';
  const url = `${BASE}?collection=markets&kind=market-news${tag}&sort=published&order=desc&limit=${Math.min(100, Math.max(1, limit))}`;
  return parseNichedbNews(await ctx.http.json<unknown>(url, { source: NICHEDB_NEWS, ttl: 300 }));
}
