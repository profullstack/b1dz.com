/**
 * U.S. Bureau of Labor Statistics public data API.
 *
 * Version 1 needs no key but allows roughly 25 requests a day per address,
 * 25 series and 10 years per request, so every card batches its series into
 * one POST and caches it for six hours. With a BLS key version 2 is used.
 */
import { pctChange } from '../../format.js';
import { SourceError, type Ctx } from '../../types.js';
import type { Point } from './data.js';

export interface BlsObs {
  /** ms epoch, first day of the month or quarter (UTC). */
  t: number;
  value: number;
  /** "2026-10" or "2026-Q3". */
  period: string;
}

interface BlsResponse {
  status?: string;
  message?: string[];
  Results?: { series?: { seriesID: string; data?: { year: string; period: string; value: string }[] }[] };
}

/** Series of a BLS response, oldest first. Annual averages (M13, Q05, S03) and missing values are dropped. */
export function parseBls(body: BlsResponse): Map<string, BlsObs[]> {
  const out = new Map<string, BlsObs[]>();
  for (const s of body.Results?.series ?? []) {
    const list: BlsObs[] = [];
    for (const d of s.data ?? []) {
      const year = Number(d.year);
      const value = Number(String(d.value).replace(/,/g, ''));
      if (!Number.isFinite(year) || d.value === '-' || d.value === '' || !Number.isFinite(value)) continue;
      const m = /^([MQ])(\d{2})$/.exec(d.period);
      if (!m) continue;
      const n = Number(m[2]);
      if (m[1] === 'M' && n >= 1 && n <= 12) list.push({ t: Date.UTC(year, n - 1, 1), value, period: `${year}-${m[2]}` });
      else if (m[1] === 'Q' && n >= 1 && n <= 4) list.push({ t: Date.UTC(year, (n - 1) * 3, 1), value, period: `${year}-Q${n}` });
    }
    list.sort((a, b) => a.t - b.t);
    out.set(s.seriesID, list);
  }
  return out;
}

export async function blsSeries(ctx: Ctx, ids: string[], startYear: number, endYear: number): Promise<{ series: Map<string, BlsObs[]>; keyed: boolean }> {
  if (!ids.length) return { series: new Map(), keyed: false };
  const key = ctx.key('BLS');
  const limit = key ? 50 : 25;
  if (ids.length > limit) throw new SourceError('BLS', `at most ${limit} series per request`);
  const span = key ? 20 : 10;
  const from = Math.max(startYear, endYear - span + 1);
  const url = `https://api.bls.gov/publicAPI/${key ? 'v2' : 'v1'}/timeseries/data/`;
  const payload: Record<string, unknown> = { seriesid: ids, startyear: String(from), endyear: String(endYear) };
  if (key) payload.registrationkey = key;
  const body = await ctx.http.json<BlsResponse>(url, { source: 'BLS', ttl: 21600, method: 'POST', body: payload, timeoutMs: 30_000 });
  if (body.status !== 'REQUEST_SUCCEEDED') {
    const why = (body.message ?? []).join(' ').trim() || body.status || 'request refused';
    throw new SourceError('BLS', /threshold|limit/i.test(why) ? `daily request limit reached (${why})` : why);
  }
  return { series: parseBls(body), keyed: Boolean(key) };
}

export const BLS_KEYLESS_NOTE = 'No BLS key set: the keyless API allows about 25 requests a day, so results are cached for six hours.';

/** The observation `months` months before the one at `index`, matched on the calendar, not on position. */
export function monthsBefore(list: BlsObs[], index: number, months: number): BlsObs | undefined {
  const at = list[index];
  if (!at) return undefined;
  const d = new Date(at.t);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1);
  for (let i = index - 1; i >= 0; i--) {
    if (list[i].t === target) return list[i];
    if (list[i].t < target) return undefined;
  }
  return undefined;
}

/** Percent change on `months` months earlier at `index` (default: the latest observation). */
export function changeOver(list: BlsObs[], months: number, index = list.length - 1): number | null {
  const at = list[index];
  const before = monthsBefore(list, index, months);
  return at && before ? pctChange(at.value, before.value) : null;
}

/** Level difference on `months` months earlier at `index`. */
export function diffOver(list: BlsObs[], months: number, index = list.length - 1): number | null {
  const at = list[index];
  const before = monthsBefore(list, index, months);
  return at && before ? at.value - before.value : null;
}

/** The whole series as 12-month percent changes. */
export function yoySeries(list: BlsObs[]): Point[] {
  const out: Point[] = [];
  list.forEach((o, i) => {
    const c = changeOver(list, 12, i);
    if (c !== null) out.push([o.t, c]);
  });
  return out;
}
