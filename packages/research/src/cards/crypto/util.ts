/** Shared helpers for the crypto cards: the coin input, tolerant JSON access, small maths. */
import { num } from '../../http.js';
import type { Ctx, ParamSpec } from '../../types.js';

export const DAY = 86_400_000;

/** One input drives every coin card: a symbol (BTC) or a dollar pair (BTC-USD). */
export const SYMBOL_PARAM: ParamSpec = { name: 'symbol', label: 'Coin', default: 'BTC-USD', hint: 'coin or pair, e.g. BTC, ETH-USD, SOL' };

/** "btc-usd", "ETH/USDT", "solusd", "XBT" to the coin symbol (BTC, ETH, SOL). */
export function baseOf(input: string | undefined, fallback = 'BTC'): string {
  let s = (input ?? '').trim().toUpperCase();
  if (!s) return fallback;
  const cut = s.split(/[-/_:\s]/)[0];
  if (cut && cut !== s) s = cut;
  else if (s.length > 5 && /(USDT|USDC|USD)$/.test(s)) s = s.replace(/(USDT|USDC|USD)$/, '');
  s = s.replace(/[^A-Z0-9]/g, '');
  if (s === 'XBT') return 'BTC';
  return s || fallback;
}

export function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** A finite number from a number or numeric text, else null. */
export function n(v: unknown): number | null {
  return num(v);
}

export function minuteStamp(ctx: Ctx): string {
  return ctx.now().toISOString().slice(0, 16) + 'Z';
}

export function share(part: number | null | undefined, total: number | null | undefined): number | null {
  if (part == null || total == null || !(total > 0)) return null;
  return (part / total) * 100;
}

export function sum(values: (number | null | undefined)[]): number {
  let t = 0;
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) t += v;
  return t;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Value of the last point at or before `t` in an ascending [ms, value] series. */
export function valueAt(points: [number, number][], t: number): number | null {
  let found: number | null = null;
  for (const p of points) {
    if (p[0] > t) break;
    found = p[1];
  }
  return found;
}

/** Percent change of the last point against the point `days` earlier. */
export function changeOver(points: [number, number][], days: number): number | null {
  if (!points.length) return null;
  const last = points[points.length - 1];
  const then = valueAt(points, last[0] - days * DAY);
  if (then === null || then === 0) return null;
  return (last[1] / then - 1) * 100;
}

const RANGE_DAYS: Record<string, number> = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '2Y': 731, '5Y': 1827, '10Y': 3653, MAX: 100_000 };

export const RANGE_CHOICES = Object.keys(RANGE_DAYS);

export function rangeDays(range: string | undefined, fallback = '1Y'): number {
  return RANGE_DAYS[(range ?? fallback).toUpperCase()] ?? RANGE_DAYS[fallback];
}

/** Keep the points of an ascending series that fall inside the range ending at the last point. */
export function clip(points: [number, number][], range: string | undefined, fallback = '1Y'): [number, number][] {
  if (!points.length) return points;
  const from = points[points.length - 1][0] - rangeDays(range, fallback) * DAY;
  return points.filter((p) => p[0] >= from);
}

/** Title-case a lower-case slug: "hyperliquid l1" to "Hyperliquid L1". */
export function titleCase(s: string): string {
  return s.replace(/(^|[\s_-])([a-z])/g, (_m, sep: string, c: string) => `${sep === '_' || sep === '-' ? ' ' : sep}${c.toUpperCase()}`);
}
