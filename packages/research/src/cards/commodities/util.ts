/** Small helpers shared by the currency, commodity, energy and agriculture cards. */
import { pctChange } from '../../format.js';
import { rangeStart, RANGES, type Range } from '../../lib/market.js';
import type { Column, ParamSpec } from '../../types.js';

export type Point = [number, number];

export const DAY = 86_400_000;

export function toRange(v: string | undefined, fallback: Range = '1Y'): Range {
  const s = (v ?? '').trim().toUpperCase() as Range;
  return RANGES.includes(s) ? s : fallback;
}

export function rangeParam(def: Range = '1Y', choices: Range[] = ['1M', '3M', '6M', '1Y', '2Y', '5Y']): ParamSpec {
  return { name: 'range', label: 'Range', default: def, choices };
}

export const ymd = (d: Date | number): string => new Date(d).toISOString().slice(0, 10);

/** Start of `range` as YYYY-MM-DD. */
export function startOf(range: Range, now: Date): string {
  return ymd(rangeStart(range, now));
}

/** First day of the month `months` before `now`, as YYYY-MM-DD: a start date that only changes monthly, so URLs stay cacheable. */
export function monthStartBack(now: Date, months: number): string {
  return ymd(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
}

/**
 * Parse a provider period into ms epoch (UTC): YYYY, YYYY-MM, YYYY-MM-DD,
 * YYYY-MM-DDTHH (EIA hourly), YYYY-Mmm and YYYY-Qn (IMF). Monthly, quarterly
 * and annual periods map to the first day of the period.
 */
export function periodMs(p: string): number {
  const s = p.trim();
  let m = /^(\d{4})-M(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, 1);
  m = /^(\d{4})-Q([1-4])$/.exec(s);
  if (m) return Date.UTC(+m[1], (+m[2] - 1) * 3, 1);
  m = /^(\d{4})$/.exec(s);
  if (m) return Date.UTC(+m[1], 0, 1);
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, 1);
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]);
  return NaN;
}

/** Value of the last point on or before `t` (points oldest first), or null. */
export function valueAt(points: Point[], t: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : points[found][1];
}

export function monthsBack(t: number, months: number): number {
  const d = new Date(t);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months + 1, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, Math.min(d.getUTCDate(), lastDay));
}

export interface PointReturns {
  last: number | null;
  asOf: number | null;
  prev: number | null;
  w1: number | null;
  m1: number | null;
  m3: number | null;
  ytd: number | null;
  y1: number | null;
}

/**
 * Percent change to the last point over the usual horizons. `prev` is the
 * change from the observation before the last one (a day for daily data, a
 * month for monthly). YTD is measured from the last point of the prior year.
 */
export function pointReturns(points: Point[]): PointReturns {
  if (!points.length) return { last: null, asOf: null, prev: null, w1: null, m1: null, m3: null, ytd: null, y1: null };
  const [t, last] = points[points.length - 1];
  const ret = (at: number): number | null => pctChange(last, valueAt(points, at));
  return {
    last,
    asOf: t,
    prev: points.length > 1 ? pctChange(last, points[points.length - 2][1]) : null,
    w1: ret(t - 7 * DAY),
    m1: ret(monthsBack(t, 1)),
    m3: ret(monthsBack(t, 3)),
    ytd: ret(Date.UTC(new Date(t).getUTCFullYear(), 0, 1) - 1),
    y1: ret(monthsBack(t, 12)),
  };
}

/** Points on or after `from`. */
export function since(points: Point[], from: number): Point[] {
  return points.filter((p) => p[0] >= from);
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Pearson correlation of two equal-length samples; null with fewer than three pairs or no variance. */
export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a.slice(0, n)) as number;
  const mb = mean(b.slice(0, n)) as number;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** Share of `xs` at or below `v`, 0 to 100. */
export function percentile(xs: number[], v: number): number | null {
  if (!xs.length) return null;
  return (xs.filter((x) => x <= v).length / xs.length) * 100;
}

export const RETURN_COLUMNS_DAILY: Column[] = [
  { key: 'prev', label: 'Day', format: 'signedPct' },
  { key: 'w1', label: '1W', format: 'signedPct' },
  { key: 'm1', label: '1M', format: 'signedPct' },
  { key: 'm3', label: '3M', format: 'signedPct' },
  { key: 'ytd', label: 'YTD', format: 'signedPct' },
  { key: 'y1', label: '1Y', format: 'signedPct' },
];

export const RETURN_COLUMNS_MONTHLY: Column[] = [
  { key: 'prev', label: '1M', format: 'signedPct' },
  { key: 'm3', label: '3M', format: 'signedPct' },
  { key: 'ytd', label: 'YTD', format: 'signedPct' },
  { key: 'y1', label: '1Y', format: 'signedPct' },
];
