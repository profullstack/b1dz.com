/**
 * FRED (Federal Reserve Bank of St. Louis) series.
 *
 * With a FRED key the documented API is used. Without one the public graph
 * CSV is tried; it needs no key but refuses some networks (data centres), so
 * cards should prefer a primary official source where one exists and treat
 * FRED as the deeper-history option.
 */
import { csvObjects } from '../http.js';
import { SourceError, type ChartBlock, type Ctx } from '../types.js';

export interface FredSeries {
  id: string;
  points: [number, number][];
  /** "FRED" or "FRED (public CSV)". */
  source: string;
}

export interface FredOptions {
  /** YYYY-MM-DD. Default: ten years back. */
  start?: string;
  /** Cache seconds. Default one hour. */
  ttl?: number;
}

/** Rows of the public graph CSV: a date column, then one column per series. "." marks a missing value. */
export function parseFredCsv(text: string, id: string): [number, number][] {
  const rows = csvObjects(text);
  const out: [number, number][] = [];
  for (const r of rows) {
    const date = r.observation_date ?? r.DATE ?? Object.values(r)[0];
    const raw = r[id] ?? r[id.toUpperCase()] ?? Object.values(r)[1];
    const t = Date.parse(`${date}T00:00:00Z`);
    const v = Number(raw);
    if (!Number.isNaN(t) && raw !== undefined && raw !== '.' && raw !== '' && Number.isFinite(v)) out.push([t, v]);
  }
  return out;
}

export function parseFredJson(body: { observations?: { date: string; value: string }[] }): [number, number][] {
  const out: [number, number][] = [];
  for (const o of body.observations ?? []) {
    const t = Date.parse(`${o.date}T00:00:00Z`);
    const v = Number(o.value);
    if (!Number.isNaN(t) && o.value !== '.' && Number.isFinite(v)) out.push([t, v]);
  }
  return out;
}

export async function fredSeries(ctx: Ctx, id: string, opts: FredOptions = {}): Promise<FredSeries> {
  const now = ctx.now();
  const start = opts.start ?? `${now.getUTCFullYear() - 10}-01-01`;
  const ttl = opts.ttl ?? 3600;
  const key = ctx.key('FRED');
  if (key) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${start}`;
    const body = await ctx.http.json<{ observations?: { date: string; value: string }[] }>(url, { source: 'FRED', ttl });
    return { id, points: parseFredJson(body), source: 'FRED' };
  }
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${start}`;
  const text = await ctx.http.text(url, { source: 'FRED (public CSV)', ttl, timeoutMs: 12_000 });
  const points = parseFredCsv(text, id);
  if (!points.length) throw new SourceError('FRED (public CSV)', `no observations for ${id}`);
  return { id, points, source: 'FRED (public CSV)' };
}

/** Several FRED series on one time chart. Series that fail are left out and named in `missing`. */
export async function fredChart(
  ctx: Ctx,
  series: { id: string; name: string }[],
  opts: FredOptions & { title?: string; yFormat?: ChartBlock['yFormat']; yDigits?: number } = {},
): Promise<{ block: ChartBlock; source: string; missing: string[] }> {
  const got = await Promise.allSettled(series.map((s) => fredSeries(ctx, s.id, opts)));
  const missing: string[] = [];
  const lines: ChartBlock['series'] = [];
  let source = 'FRED';
  got.forEach((g, i) => {
    if (g.status === 'fulfilled') {
      lines.push({ name: series[i].name, points: g.value.points });
      source = g.value.source;
    } else missing.push(series[i].name);
  });
  if (!lines.length) {
    const first = got[0];
    throw first.status === 'rejected' && first.reason instanceof Error ? first.reason : new SourceError('FRED', 'no series available');
  }
  return {
    block: { kind: 'chart', title: opts.title, xType: 'time', series: lines, yFormat: opts.yFormat, yDigits: opts.yDigits },
    source,
    missing,
  };
}
