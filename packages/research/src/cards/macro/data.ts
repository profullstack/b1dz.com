/** Clients for the statistical agencies the macro cards share: IMF DataMapper, and SDMX-CSV from the OECD, BIS and ECB. */
import { csvObjects } from '../../http.js';
import { SourceError, type Ctx } from '../../types.js';

export type Point = [number, number];

/** "2026", "2026-Q3", "2026-10", "2026-11-16" -> ms epoch at the start of the period (UTC). */
export function periodToMs(period: string): number | null {
  const p = period.trim();
  let m = /^(\d{4})$/.exec(p);
  if (m) return Date.UTC(Number(m[1]), 0, 1);
  m = /^(\d{4})-?Q([1-4])$/i.exec(p);
  if (m) return Date.UTC(Number(m[1]), (Number(m[2]) - 1) * 3, 1);
  m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(p);
  if (m) {
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export interface SdmxObs {
  area: string;
  period: string;
  t: number;
  value: number;
  /** Every dimension and attribute column of the row. */
  dims: Record<string, string>;
}

/** Rows of an SDMX-CSV response (TIME_PERIOD, OBS_VALUE and a REF_AREA-like column), oldest first. */
export function parseSdmxCsv(text: string, areaColumn = 'REF_AREA'): SdmxObs[] {
  const out: SdmxObs[] = [];
  for (const r of csvObjects(text)) {
    const period = r.TIME_PERIOD;
    const raw = r.OBS_VALUE;
    if (!period || raw === undefined || raw === '' || raw === 'NaN') continue;
    const value = Number(raw);
    const t = periodToMs(period);
    if (t === null || !Number.isFinite(value)) continue;
    out.push({ area: r[areaColumn] ?? '', period, t, value, dims: r });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Group observations by area, each oldest first. */
export function byArea(obs: SdmxObs[]): Map<string, SdmxObs[]> {
  const m = new Map<string, SdmxObs[]>();
  for (const o of obs) {
    const list = m.get(o.area);
    if (list) list.push(o);
    else m.set(o.area, [o]);
  }
  return m;
}

const OECD_ACCEPT = 'application/vnd.sdmx.data+csv; charset=utf-8; version=2';

/** OECD Data Explorer SDMX API. `flow` is "AGENCY,DSD@DF,version"; `key` is the dotted dimension filter. */
export async function oecdData(ctx: Ctx, flow: string, key: string, query: string, ttl = 21600): Promise<SdmxObs[]> {
  const url = `https://sdmx.oecd.org/public/rest/data/${flow}/${key}?${query}`;
  const text = await ctx.http.text(url, { source: 'OECD', ttl, headers: { accept: OECD_ACCEPT }, timeoutMs: 40_000 });
  if (/^\s*(<|\{|NoRecordsFound|NoResultsFound)/i.test(text)) throw new SourceError('OECD', `no data for ${flow}/${key}`);
  return parseSdmxCsv(text);
}

/** BIS statistics API v2. `flow` is e.g. "WS_CBPOL"; `key` the dotted filter ("D.US+XM"). */
export async function bisData(ctx: Ctx, flow: string, key: string, query: string, ttl = 3600): Promise<SdmxObs[]> {
  const url = `https://stats.bis.org/api/v2/data/dataflow/BIS/${flow}/1.0/${key}?${query}`;
  const text = await ctx.http.text(url, { source: 'BIS', ttl, headers: { accept: 'application/vnd.sdmx.data+csv' }, timeoutMs: 40_000 });
  if (/^\s*(<|\{)/.test(text)) throw new SourceError('BIS', `no data for ${flow}/${key}`);
  return parseSdmxCsv(text);
}

/** ECB data API. `flow` is e.g. "EXR"; `key` the dotted series key without the flow prefix. */
export async function ecbData(ctx: Ctx, flow: string, key: string, query: string, ttl = 3600): Promise<SdmxObs[]> {
  const sep = query ? '&' : '';
  const url = `https://data-api.ecb.europa.eu/service/data/${flow}/${key}?${query}${sep}format=csvdata`;
  const text = await ctx.http.text(url, { source: 'ECB', ttl, headers: { accept: 'text/csv' }, timeoutMs: 40_000 });
  if (!text.trim() || /^\s*(<|\{)/.test(text)) throw new SourceError('ECB', `no data for ${flow}.${key}`);
  return parseSdmxCsv(text, 'KEY');
}

/** One IMF DataMapper indicator: code -> year -> value. */
export type ImfTable = Record<string, Record<string, number>>;

export interface ImfIndicatorInfo {
  label: string;
  unit: string;
  source: string;
  dataset: string;
  description: string;
}

/** Pull the indicator's table out of a DataMapper `values` response. */
export function parseImfValues(body: unknown, indicator: string): ImfTable {
  const values = (body as { values?: Record<string, unknown> } | null)?.values;
  const table = values?.[indicator];
  if (!table || typeof table !== 'object') return {};
  const out: ImfTable = {};
  for (const [code, years] of Object.entries(table as Record<string, unknown>)) {
    if (!years || typeof years !== 'object') continue;
    const row: Record<string, number> = {};
    for (const [y, v] of Object.entries(years as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && /^\d{4}$/.test(y)) row[y] = v;
    }
    out[code] = row;
  }
  return out;
}

/** The whole indicator (every country and year) in one cached request; the API ignores narrower filters from some networks. */
export async function imfIndicator(ctx: Ctx, indicator: string): Promise<ImfTable> {
  const id = indicator.trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,40}$/.test(id)) throw new SourceError('IMF', `not an indicator code: ${indicator}`);
  const body = await ctx.http.json(`https://www.imf.org/external/datamapper/api/v1/${id}`, { source: 'IMF', ttl: 21600, timeoutMs: 40_000 });
  const table = parseImfValues(body, id);
  if (!Object.keys(table).length) throw new SourceError('IMF', `no data for indicator ${id}`);
  return table;
}

export async function imfIndicators(ctx: Ctx): Promise<Record<string, ImfIndicatorInfo>> {
  const body = await ctx.http.json<{ indicators?: Record<string, Partial<ImfIndicatorInfo>> }>('https://www.imf.org/external/datamapper/api/v1/indicators', { source: 'IMF', ttl: 86400, timeoutMs: 40_000 });
  const out: Record<string, ImfIndicatorInfo> = {};
  for (const [code, i] of Object.entries(body.indicators ?? {})) {
    if (!code) continue;
    out[code] = { label: (i.label ?? code).trim(), unit: (i.unit ?? '').trim(), source: (i.source ?? '').trim(), dataset: (i.dataset ?? '').trim(), description: (i.description ?? '').trim() };
  }
  return out;
}

/** A country's annual series as chart points (1 January of each year). */
export function imfPoints(table: ImfTable, code: string, fromYear = 0, toYear = 9999): Point[] {
  const row = table[code] ?? {};
  return Object.keys(row)
    .map(Number)
    .filter((y) => y >= fromYear && y <= toYear)
    .sort((a, b) => a - b)
    .map((y) => [Date.UTC(y, 0, 1), row[String(y)]] as Point);
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** First date of the shared `range` param counted back from `now`. Unknown ranges fall back to `fallback`. */
export function rangeStartMs(range: string | undefined, now: Date, fallback = '5Y'): number {
  const r = (range ?? fallback).toUpperCase();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const m = /^(\d+)([MY])$/.exec(r);
  if (r === 'MAX') return Date.UTC(1900, 0, 1);
  if (!m) return rangeStartMs(fallback, now, '5Y');
  if (m[2] === 'M') d.setUTCMonth(d.getUTCMonth() - Number(m[1]));
  else d.setUTCFullYear(d.getUTCFullYear() - Number(m[1]));
  return d.getTime();
}

export const RANGE_CHOICES = ['1M', '3M', '6M', '1Y', '2Y', '5Y', '10Y', 'MAX'];
