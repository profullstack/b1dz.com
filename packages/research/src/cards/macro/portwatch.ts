/** IMF PortWatch: daily vessel transits and port activity, published as ArcGIS feature services. */
import { pctChange } from '../../format.js';
import { SourceError, type Ctx } from '../../types.js';
import { mean, type Point } from './data.js';

const BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services';
export const PORTWATCH_URL = 'https://portwatch.imf.org/';
const DAY = 86_400_000;

export type Attrs = Record<string, string | number | null>;

interface ArcResponse {
  features?: { attributes: Attrs }[];
  exceededTransferLimit?: boolean;
  error?: { code?: number; message?: string; details?: string[] };
}

/** Query one PortWatch layer. `params` are ArcGIS query parameters; geometry is never requested. */
export async function arcQuery(ctx: Ctx, service: string, params: Record<string, string>, ttl = 3600): Promise<Attrs[]> {
  const qs = new URLSearchParams({ where: '1=1', outFields: '*', returnGeometry: 'false', f: 'json', ...params });
  const url = `${BASE}/${service}/FeatureServer/0/query?${qs.toString()}`;
  // The hosted tables intermittently answer a valid query with HTTP 200 and a 400 error body ("Invalid URL",
  // "Cannot perform query") while they are being refreshed. The same query succeeds moments later, so it is
  // retried with a short pause; each retry varies the URL so a cached error body is not replayed.
  let body: ArcResponse = {};
  for (let attempt = 0; attempt < ARC_ATTEMPTS; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    body = await ctx.http.json<ArcResponse>(attempt ? `${url}&retry=${attempt}` : url, { source: 'IMF PortWatch', ttl, timeoutMs: 45_000 });
    if (!body.error || !isTransient(body.error)) break;
  }
  if (body.error) throw new SourceError('IMF PortWatch', `${service}: ${body.error.message ?? 'query refused'}${body.error.code === 499 ? ' (private layer)' : ''}`);
  return (body.features ?? []).map((f) => f.attributes);
}

const ARC_ATTEMPTS = 6;

/** Error bodies seen from a healthy query while a table is mid-refresh. Token errors (499) are never transient. */
export function isTransient(error: { code?: number; message?: string }): boolean {
  return error.code === 400 && /invalid url|cannot perform query|object reference/i.test(error.message ?? '');
}

/** PortWatch dates arrive as "YYYY-MM-DD" (date-only fields) or ms epoch (timestamp fields). */
export function arcDate(v: string | number | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function ymd(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export interface Chokepoint {
  id: string;
  name: string;
}

/** The chokepoints on the monitor. Ids are PortWatch's own. */
export const CHOKEPOINTS: Chokepoint[] = [
  { id: 'chokepoint6', name: 'Strait of Hormuz' },
  { id: 'chokepoint4', name: 'Bab el-Mandeb' },
  { id: 'chokepoint1', name: 'Suez Canal' },
  { id: 'chokepoint7', name: 'Cape of Good Hope' },
  { id: 'chokepoint3', name: 'Bosporus' },
  { id: 'chokepoint2', name: 'Panama Canal' },
  { id: 'chokepoint5', name: 'Malacca Strait' },
  { id: 'chokepoint11', name: 'Taiwan Strait' },
];

export function findChokepoint(input: string | undefined): Chokepoint {
  const q = (input ?? '').trim().toLowerCase();
  if (!q) return CHOKEPOINTS[0];
  const hit = CHOKEPOINTS.find((c) => c.id === q || c.name.toLowerCase() === q) ?? CHOKEPOINTS.find((c) => c.name.toLowerCase().includes(q));
  if (!hit) throw new SourceError('IMF PortWatch', `unknown chokepoint "${input}". Choices: ${CHOKEPOINTS.map((c) => c.name).join(', ')}`);
  return hit;
}

export const VESSEL_FIELDS = ['n_total', 'n_tanker', 'n_container', 'n_dry_bulk'] as const;
export type VesselField = (typeof VESSEL_FIELDS)[number];

export interface DailyTransits {
  t: number;
  portid: string;
  n_total: number;
  n_tanker: number;
  n_container: number;
  n_dry_bulk: number;
}

export function toTransits(rows: Attrs[]): DailyTransits[] {
  const out: DailyTransits[] = [];
  for (const r of rows) {
    const t = arcDate(r.date);
    if (t === null || typeof r.portid !== 'string') continue;
    const n = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0);
    out.push({ t, portid: r.portid, n_total: n('n_total'), n_tanker: n('n_tanker'), n_container: n('n_container'), n_dry_bulk: n('n_dry_bulk') });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Daily transits for some chokepoints from `from` (ms) onwards, oldest first. */
export async function chokepointDaily(ctx: Ctx, ids: string[], from: number): Promise<DailyTransits[]> {
  const list = ids.map((i) => `'${i.replace(/[^a-z0-9]/gi, '')}'`).join(',');
  const rows = await arcQuery(ctx, 'Daily_Chokepoints_Data', {
    where: `portid IN (${list}) AND date >= DATE '${ymd(from)}'`,
    outFields: ['date', 'portid', ...VESSEL_FIELDS].join(','),
    orderByFields: 'date ASC',
    resultRecordCount: '10000',
  });
  const out = toTransits(rows);
  if (!out.length) throw new SourceError('IMF PortWatch', 'no chokepoint transits returned');
  return out;
}

/** Mean of `field` over the `days` days ending at `end` (inclusive). Null when the window has no observations. */
export function windowMean(rows: DailyTransits[], field: VesselField, end: number, days = 7): number | null {
  const start = end - (days - 1) * DAY;
  return mean(rows.filter((r) => r.t >= start && r.t <= end).map((r) => r[field]));
}

export interface TransitSummary {
  latest: number | null;
  yearAgo: number | null;
  /** Percent change of the latest week on the same week a year earlier (364 days back, so weekdays line up). */
  vsYearAgo: number | null;
  /** Percent change of the latest week on the baseline average. */
  vsBaseline: number | null;
}

/** Seven-day average ending at `end`, against the week 364 days earlier and against a baseline level. */
export function summariseTransits(rows: DailyTransits[], field: VesselField, end: number, baseline: number | null): TransitSummary {
  const latest = windowMean(rows, field, end);
  const yearAgo = windowMean(rows, field, end - 364 * DAY);
  return { latest, yearAgo, vsYearAgo: pctChange(latest, yearAgo), vsBaseline: pctChange(latest, baseline) };
}

/** Seven-day trailing mean of one field as chart points. Assumes one row per day (PortWatch has no gaps). */
export function smoothed(rows: DailyTransits[], field: VesselField, window = 7): Point[] {
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i][field];
    if (i >= window) sum -= rows[i - window][field];
    if (i >= window - 1) out.push([rows[i].t, sum / window]);
  }
  return out;
}

/** Average daily transits per chokepoint over one calendar year (the 2023 baseline, before the Red Sea diversions). */
export async function chokepointYearAverage(ctx: Ctx, year: number): Promise<Map<string, Record<VesselField, number>>> {
  const rows = await arcQuery(
    ctx,
    'Daily_Chokepoints_Data',
    {
      where: `year = ${Math.trunc(year)}`,
      groupByFieldsForStatistics: 'portid',
      outStatistics: JSON.stringify(VESSEL_FIELDS.map((f) => ({ statisticType: 'avg', onStatisticField: f, outStatisticFieldName: f }))),
    },
    86400,
  );
  const out = new Map<string, Record<VesselField, number>>();
  for (const r of rows) {
    if (typeof r.portid !== 'string') continue;
    const rec = {} as Record<VesselField, number>;
    for (const f of VESSEL_FIELDS) rec[f] = typeof r[f] === 'number' ? (r[f] as number) : NaN;
    out.set(r.portid, rec);
  }
  return out;
}
