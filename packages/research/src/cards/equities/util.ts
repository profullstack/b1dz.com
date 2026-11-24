/** Helpers shared by the equities cards: params, Nasdaq table shapes and return statistics. */
import { num } from '../../http.js';
import type { Bar } from '../../lib/market.js';
import type { ParamSpec } from '../../types.js';

export const SYMBOL: ParamSpec = { name: 'symbol', label: 'Symbol', default: 'AAPL', hint: 'U.S. ticker, e.g. AAPL' };

export function symbolOf(params: Record<string, string>, fallback = 'AAPL'): string {
  return (params.symbol || fallback).trim().toUpperCase();
}

/** "AAPL, msft;GOOG" -> ['AAPL', 'MSFT', 'GOOG'] (unique, in order). */
export function symbolList(text: string | undefined): string[] {
  const out: string[] = [];
  for (const s of (text ?? '').split(/[\s,;]+/)) {
    const u = s.trim().toUpperCase();
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/** MM/DD/YYYY (or M/D/YYYY) -> YYYY-MM-DD; anything else is returned unchanged ('' for N/A). */
export function usDate(s: string | null | undefined): string {
  const v = (s ?? '').trim();
  if (!v || /^n\/?a$/i.test(v) || v === '--') return '';
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : v;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Nov 12, 2026" -> 2026-11-12; unparseable text is returned unchanged. */
export function longDate(s: string | null | undefined): string {
  const v = (s ?? '').trim();
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/.exec(v);
  if (!m) return usDate(v);
  const i = MONTHS.indexOf(m[1].toLowerCase());
  return i < 0 ? v : `${m[3]}-${String(i + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export interface ValueTable {
  /** Period labels, newest first as Nasdaq sends them. */
  periods: string[];
  rows: { label: string; values: (number | null)[]; heading: boolean }[];
}

interface RawValueTable {
  headers?: Record<string, string> | null;
  rows?: Record<string, string>[] | null;
}

/**
 * Nasdaq statement tables: `headers` is { value1: caption, value2..N: period },
 * rows repeat the keys. A row whose cells are all empty strings is a section
 * heading. `scale` converts the reported unit (thousands) to units.
 */
export function parseValueTable(t: RawValueTable | null | undefined, scale = 1): ValueTable {
  const keys = Object.keys(t?.headers ?? {}).filter((k) => k !== 'value1').sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  const periods = keys.map((k) => usDate(t?.headers?.[k]));
  const rows = (t?.rows ?? []).map((r) => {
    const raw = keys.map((k) => r[k] ?? '');
    const pct = raw.some((x) => x.includes('%'));
    return {
      label: (r.value1 ?? '').trim(),
      heading: raw.every((x) => x === ''),
      values: raw.map((x) => {
        const n = num(x);
        return n === null ? null : pct ? n : n * scale;
      }),
    };
  });
  return { periods, rows };
}

export function rowOf(t: ValueTable, label: string | RegExp): (number | null)[] {
  const r = t.rows.find((x) => (typeof label === 'string' ? x.label.toLowerCase() === label.toLowerCase() : label.test(x.label)));
  return r ? r.values : t.periods.map(() => null);
}

// ---------------------------------------------------------------- statistics

export function median(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Linear-interpolated percentile (p in 0..100) of the finite values. */
export function percentile(values: (number | null | undefined)[], p: number): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (v.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

/** Sample standard deviation. */
export function stdev(v: number[]): number {
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
}

/** Simple daily returns keyed by bar time (fractions, not percent). */
export function dailyReturns(bars: Bar[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 1; i < bars.length; i++) if (bars[i - 1].c > 0) out.set(bars[i].t, bars[i].c / bars[i - 1].c - 1);
  return out;
}

/** Returns of two series on the days both have one. */
export function align(a: Map<number, number>, b: Map<number, number>): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (const [t, v] of a) {
    const w = b.get(t);
    if (w !== undefined) {
      x.push(v);
      y.push(w);
    }
  }
  return { x, y };
}

export function correlation(x: number[], y: number[]): number | null {
  if (x.length < 3 || x.length !== y.length) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Slope of y on x: covariance / variance of x. */
export function beta(x: number[], y: number[]): number | null {
  if (x.length < 3 || x.length !== y.length) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : null;
}

/** Annualised volatility in percent from daily returns (252 trading days). */
export function annualVol(returns: number[], periods = 252): number | null {
  const s = stdev(returns);
  return Number.isFinite(s) ? s * Math.sqrt(periods) * 100 : null;
}

/** Deepest peak-to-trough fall of the closes, in percent (a negative number, 0 when it never fell). */
export function maxDrawdown(bars: Bar[]): number | null {
  if (!bars.length) return null;
  let peak = bars[0].c;
  let worst = 0;
  for (const b of bars) {
    if (b.c > peak) peak = b.c;
    if (peak > 0) worst = Math.min(worst, b.c / peak - 1);
  }
  return worst * 100;
}

/** Percent return from the first to the last bar. */
export function totalReturn(bars: Bar[]): number | null {
  if (bars.length < 2 || bars[0].c <= 0) return null;
  return (bars[bars.length - 1].c / bars[0].c - 1) * 100;
}

export function safeDiv(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

export function pct(a: number | null | undefined, b: number | null | undefined): number | null {
  const r = safeDiv(a, b);
  return r === null ? null : r * 100;
}
