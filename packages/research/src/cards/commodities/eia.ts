/**
 * U.S. Energy Information Administration open data, API v2.
 *
 * Every dataset is a route (`petroleum/pri/spt`) with facets; requesting a
 * route without `/data` lists its facets and frequencies. A user key is used
 * when configured; otherwise the shared `DEMO_KEY`, which allows only a
 * handful of requests an hour per address, so each card asks for a long
 * range of several series in ONE request and caches it for hours.
 */
import { num } from '../../http.js';
import { SourceError, type Ctx } from '../../types.js';
import { periodMs, type Point } from './util.js';

export const EIA = 'EIA';
export const EIA_URL = 'https://www.eia.gov/opendata/browser/';
const BASE = 'https://api.eia.gov/v2';

export type EiaRow = Record<string, string | number | null | undefined>;

export interface EiaQuery {
  frequency?: string;
  /** Facet name -> accepted values. */
  facets?: Record<string, string[]>;
  /** Data columns. Default ['value']. */
  data?: string[];
  start?: string;
  end?: string;
  /** Max rows (the API caps a response at 5000). */
  length?: number;
  /** Cache seconds. Default six hours. */
  ttl?: number;
}

/** The request URL without the key (also what tests assert on). */
export function eiaPath(route: string, q: EiaQuery = {}): string {
  const parts: string[] = [];
  if (q.frequency) parts.push(`frequency=${encodeURIComponent(q.frequency)}`);
  (q.data ?? ['value']).forEach((d, i) => parts.push(`data[${i}]=${encodeURIComponent(d)}`));
  for (const [name, values] of Object.entries(q.facets ?? {})) {
    for (const v of values) parts.push(`facets[${name}][]=${encodeURIComponent(v)}`);
  }
  if (q.start) parts.push(`start=${encodeURIComponent(q.start)}`);
  if (q.end) parts.push(`end=${encodeURIComponent(q.end)}`);
  parts.push('sort[0][column]=period', 'sort[0][direction]=desc', `length=${Math.min(5000, q.length ?? 5000)}`);
  return `${BASE}/${route.replace(/^\/|\/$/g, '')}/data/?${parts.join('&')}`;
}

export function eiaKey(ctx: Ctx): string {
  return ctx.key('EIA') ?? 'DEMO_KEY';
}

/** The caveat every EIA card carries when no key is configured. */
export function eiaNotes(ctx: Ctx): string[] {
  return ctx.key('EIA')
    ? []
    : ['Using the shared EIA demo key, which is limited to a few requests an hour per address. Add a free key for reliable access: b1dz research keys set EIA <key>.'];
}

interface EiaBody {
  response?: { total?: string | number; data?: EiaRow[]; warnings?: { warning?: string; description?: string }[] };
  error?: string | { code?: string; message?: string };
}

/** Rows of the response, newest first. Throws on an API error body or an empty result. */
export function parseEiaBody(body: unknown, route: string): EiaRow[] {
  const b = body as EiaBody;
  if (b?.error) {
    const msg = typeof b.error === 'string' ? b.error : (b.error.message ?? b.error.code ?? 'error');
    throw new SourceError(EIA, `${route}: ${msg}`);
  }
  const rows = b?.response?.data;
  if (!Array.isArray(rows)) throw new SourceError(EIA, `${route}: unexpected response`);
  if (!rows.length) throw new SourceError(EIA, `${route}: no rows`);
  return rows;
}

export async function eiaData(ctx: Ctx, route: string, q: EiaQuery = {}): Promise<EiaRow[]> {
  const url = `${eiaPath(route, q)}&api_key=${encodeURIComponent(eiaKey(ctx))}`;
  const body = await ctx.http.json<unknown>(url, { source: EIA, ttl: q.ttl ?? 21_600, timeoutMs: 45_000 });
  return parseEiaBody(body, route);
}

/** Points (oldest first) of the rows whose `field` equals `id`. `valueField` defaults to "value". */
export function eiaPoints(rows: EiaRow[], field: string, id: string, valueField = 'value'): Point[] {
  const out: Point[] = [];
  for (const r of rows) {
    if (r[field] !== id) continue;
    const t = periodMs(String(r.period ?? ''));
    const v = num(r[valueField]);
    if (!Number.isNaN(t) && v !== null) out.push([t, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** The first row for a series: handy for its description and units. */
export function eiaMeta(rows: EiaRow[], field: string, id: string): EiaRow | undefined {
  return rows.find((r) => r[field] === id);
}

/** Inner join of several series on their timestamps: one entry per date every series has. */
export function alignPoints(series: Point[][]): { t: number; v: number[] }[] {
  if (!series.length) return [];
  const maps = series.map((s) => new Map(s));
  const out: { t: number; v: number[] }[] = [];
  for (const [t] of series[0]) {
    const v: number[] = [];
    for (const m of maps) {
      const x = m.get(t);
      if (x === undefined) break;
      v.push(x);
    }
    if (v.length === series.length) out.push({ t, v });
  }
  return out;
}
