import { describe, expect, it } from 'vitest';
import { monthsBefore, resolveMaturity, schedule, valueAtYield, yieldFromPrice, type Bond } from './bondmath.js';

const par10: Bond = { coupon: 5, maturity: '2036-05-15', frequency: 2 };

describe('schedule', () => {
  it('walks coupon dates back from maturity', () => {
    const s = schedule({ coupon: 4, maturity: '2028-08-31', frequency: 2 }, '2026-11-24');
    expect(s.dates).toEqual(['2027-02-28', '2027-08-31', '2028-02-29', '2028-08-31']);
    expect(s.previous).toBe('2026-08-31');
    expect(s.w).toBeGreaterThan(0);
    expect(s.w).toBeLessThan(1);
  });

  it('has a full period to go on a coupon date', () => {
    const s = schedule(par10, '2026-05-15');
    expect(s.w).toBe(1);
    expect(s.dates).toHaveLength(20);
  });

  it('rejects a matured bond', () => {
    expect(() => schedule(par10, '2036-05-15')).toThrow();
  });

  it('shifts months with end-of-month clamping, both directions', () => {
    expect(monthsBefore('2026-03-31', 1)).toBe('2026-02-28');
    expect(monthsBefore('2026-01-15', 2)).toBe('2025-11-15');
    expect(monthsBefore('2026-11-24', -120)).toBe('2036-11-24');
  });
});

describe('valueAtYield', () => {
  it('prices a bond at par when the yield equals the coupon on a coupon date', () => {
    const v = valueAtYield(par10, '2026-05-15', 5);
    expect(v.clean).toBeCloseTo(100, 8);
    expect(v.accrued).toBeCloseTo(0, 10);
    // Textbook values for a 10-year 5% semi-annual par bond.
    expect(v.macaulay).toBeCloseTo(7.9894, 3);
    expect(v.modified).toBeCloseTo(7.7946, 3);
    expect(v.dv01).toBeCloseTo(0.077946, 5);
  });

  it('prices a zero-coupon bond in closed form with duration equal to maturity', () => {
    const v = valueAtYield({ coupon: 0, maturity: '2031-05-15', frequency: 2 }, '2026-05-15', 4);
    expect(v.clean).toBeCloseTo(100 / 1.02 ** 10, 8);
    expect(v.macaulay).toBeCloseTo(5, 8);
    // Zero: convexity = n(n+1) / ((1+r)^2 f^2) with n = 10 periods.
    expect(v.convexity).toBeCloseTo(110 / (1.02 ** 2 * 4), 8);
  });

  it('accrues half a coupon half way through the period', () => {
    const v = valueAtYield({ coupon: 6, maturity: '2030-12-31', frequency: 1 }, '2026-07-02', 6);
    expect(v.accrued).toBeCloseTo(6 * (183 / 365), 6);
    expect(v.dirty).toBeCloseTo(v.clean + v.accrued, 10);
  });

  it('agrees with a finite-difference duration and convexity', () => {
    const bond: Bond = { coupon: 3.75, maturity: '2041-02-15', frequency: 2 };
    const settle = '2026-11-24';
    const y = 4.6;
    const h = 0.01;
    const v = valueAtYield(bond, settle, y);
    const up = valueAtYield(bond, settle, y + h).dirty;
    const down = valueAtYield(bond, settle, y - h).dirty;
    expect((down - up) / (2 * (h / 100) * v.dirty)).toBeCloseTo(v.modified, 4);
    expect((up + down - 2 * v.dirty) / ((h / 100) ** 2 * v.dirty)).toBeCloseTo(v.convexity, 2);
    expect((down - up) / 2).toBeCloseTo(v.dv01, 5);
  });

  it('moves price opposite to yield', () => {
    expect(valueAtYield(par10, '2026-11-24', 6).clean).toBeLessThan(valueAtYield(par10, '2026-11-24', 4).clean);
  });
});

describe('yieldFromPrice', () => {
  it('round-trips price and yield', () => {
    const bond: Bond = { coupon: 4.25, maturity: '2034-11-15', frequency: 2 };
    for (const y of [-0.5, 0.25, 4.25, 9.9, 35]) {
      const price = valueAtYield(bond, '2026-11-24', y).clean;
      expect(yieldFromPrice(bond, '2026-11-24', price)).toBeCloseTo(y, 7);
    }
  });

  it('works for quarterly and monthly coupons', () => {
    for (const frequency of [4, 12]) {
      const bond: Bond = { coupon: 7, maturity: '2029-03-01', frequency };
      const price = valueAtYield(bond, '2026-11-24', 8.2).clean;
      expect(yieldFromPrice(bond, '2026-11-24', price)).toBeCloseTo(8.2, 7);
    }
  });

  it('rejects a non-positive price', () => {
    expect(() => yieldFromPrice(par10, '2026-11-24', 0)).toThrow();
  });
});

describe('resolveMaturity', () => {
  it('accepts a date or a tenor', () => {
    expect(resolveMaturity('2031-06-30', '2026-11-24')).toBe('2031-06-30');
    expect(resolveMaturity('10y', '2026-11-24')).toBe('2036-11-24');
    expect(resolveMaturity('18M', '2026-11-30')).toBe('2028-05-30');
    expect(() => resolveMaturity('soon', '2026-11-24')).toThrow();
  });
});
