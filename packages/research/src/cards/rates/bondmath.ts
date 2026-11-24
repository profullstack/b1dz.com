/**
 * Fixed-coupon bond maths: price from yield, yield from price, accrued
 * interest, Macaulay and modified duration, convexity and DV01.
 *
 * Street convention: periodic compounding at the coupon frequency, the
 * fraction of the current coupon period measured in actual days
 * (actual/actual). Prices are per 100 of face value; rates are in percent.
 */
import { DAY, dayMs } from './util.js';

export interface Bond {
  /** Annual coupon rate, percent of face. */
  coupon: number;
  /** YYYY-MM-DD. */
  maturity: string;
  /** Coupons per year: 1, 2, 4 or 12. */
  frequency: number;
  /** Redemption per 100 face. Default 100. */
  redemption?: number;
}

export interface Schedule {
  /** Coupon dates after settlement, in order; the last is maturity. */
  dates: string[];
  /** The coupon date on or before settlement (the start of the running period). */
  previous: string;
  /** Fraction of the running period still to go, 0 < w <= 1. */
  w: number;
}

/** `months` before a date, keeping the anchor's day of month where the month allows. */
export function monthsBefore(anchor: string, months: number): string {
  const [y, m, d] = anchor.split('-').map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function schedule(bond: Bond, settle: string): Schedule {
  if (!(dayMs(bond.maturity) > dayMs(settle))) throw new Error('maturity must be after settlement');
  const step = 12 / bond.frequency;
  const dates: string[] = [];
  let k = 0;
  let date = bond.maturity;
  while (date > settle) {
    dates.unshift(date);
    k += 1;
    date = monthsBefore(bond.maturity, k * step);
  }
  const period = dayMs(dates[0]) - dayMs(date);
  return { dates, previous: date, w: (dayMs(dates[0]) - dayMs(settle)) / period };
}

export interface BondValue {
  /** Percent. */
  yield: number;
  clean: number;
  dirty: number;
  accrued: number;
  /** Years. */
  macaulay: number;
  modified: number;
  convexity: number;
  /** Price change per 100 face for a one basis point fall in yield. */
  dv01: number;
  couponsLeft: number;
  nextCoupon: string;
}

/** Full valuation at a given yield (percent). */
export function valueAtYield(bond: Bond, settle: string, yieldPct: number): BondValue {
  const s = schedule(bond, settle);
  const f = bond.frequency;
  const c = bond.coupon / f;
  const r = yieldPct / 100 / f;
  if (r <= -1) throw new Error('yield is below -100% per period');
  const redemption = bond.redemption ?? 100;
  let dirty = 0;
  let timeWeighted = 0;
  let convex = 0;
  s.dates.forEach((_, i) => {
    const tau = s.w + i;
    const cash = c + (i === s.dates.length - 1 ? redemption : 0);
    const pv = cash / (1 + r) ** tau;
    dirty += pv;
    timeWeighted += (tau / f) * pv;
    convex += pv * tau * (tau + 1);
  });
  const accrued = c * (1 - s.w);
  const macaulay = timeWeighted / dirty;
  const modified = macaulay / (1 + r);
  return {
    yield: yieldPct,
    clean: dirty - accrued,
    dirty,
    accrued,
    macaulay,
    modified,
    convexity: convex / (dirty * (1 + r) ** 2 * f * f),
    dv01: (modified * dirty) / 10_000,
    couponsLeft: s.dates.length,
    nextCoupon: s.dates[0],
  };
}

/** Yield (percent) that reproduces a clean price, by bisection. Price falls as yield rises. */
export function yieldFromPrice(bond: Bond, settle: string, clean: number): number {
  if (!(clean > 0)) throw new Error('price must be positive');
  let lo = -50;
  let hi = 1000;
  const gap = (y: number) => valueAtYield(bond, settle, y).clean - clean;
  if (gap(lo) < 0 || gap(hi) > 0) throw new Error('no yield between -50% and 1000% gives that price');
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gap(mid) > 0) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

/** A maturity given as a date or as a tenor ("10Y", "18M") from settlement. */
export function resolveMaturity(input: string, settle: string): string {
  const s = input.trim().toUpperCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d+(?:\.\d+)?)\s*([MY])$/.exec(s);
  if (!m) throw new Error(`maturity "${input}" is neither YYYY-MM-DD nor a tenor like 10Y`);
  const months = Math.round(Number(m[1]) * (m[2] === 'Y' ? 12 : 1));
  if (months < 1) throw new Error('maturity must be at least one month away');
  return monthsBefore(settle, -months);
}

export function yearsBetween(from: string, to: string): number {
  return (dayMs(to) - dayMs(from)) / (365.25 * DAY);
}

