import { describe, it, expect } from 'vitest';
import { sellVolumeWithCushion, sellabilityBlocker } from './sellability.js';

describe('sellVolumeWithCushion', () => {
  it('applies the default 0.5% cushion when well above venue min', () => {
    // 10 available, cap=10, min=1. Cushioned 9.95 is still ≥ min → use cushioned.
    const v = sellVolumeWithCushion(10, 10, { baseMinSize: 1 });
    expect(v).toBeCloseTo(9.95, 6);
  });

  it('regression: RAVE-USD 0.1 balance with base_min_size 0.1 — drop cushion', () => {
    // The exact failure mode from production logs.
    // 0.1 × 0.995 = 0.0995 < 0.1 base_min_size, but we hold 0.1.
    const v = sellVolumeWithCushion(0.1, 0.1, { baseMinSize: 0.1 });
    expect(v).toBe(0.1);
  });

  it('drops cushion when cushioned size < venue min but balance ≥ min', () => {
    // 1.001 available, cap=1.001, min=1. Cushioned 0.996 < 1 but balance ≥ 1.
    const v = sellVolumeWithCushion(1.001, 1.001, { baseMinSize: 1 });
    expect(v).toBeCloseTo(1.001, 6);
  });

  it('keeps cushion when balance is already below venue min (venue will reject)', () => {
    // 0.5 available, cap=0.5, min=1. No amount of cushion-dropping saves this.
    const v = sellVolumeWithCushion(0.5, 0.5, { baseMinSize: 1 });
    // Returns cushioned — downstream min check will still reject; not our job here.
    expect(v).toBeCloseTo(0.4975, 6);
  });

  it('caps sellVolume at the `cap` argument when cap < cushioned', () => {
    // availableBase 100, cap 5 — never sells more than the caller asked.
    const v = sellVolumeWithCushion(100, 5, { baseMinSize: 0 });
    expect(v).toBe(5);
  });

  it('returns 0 on invalid inputs', () => {
    expect(sellVolumeWithCushion(NaN, 1, null)).toBe(0);
    expect(sellVolumeWithCushion(0, 1, null)).toBe(0);
    expect(sellVolumeWithCushion(1, 0, null)).toBe(0);
  });

  it('applies cushion even with null limits (preserves legacy behavior)', () => {
    const v = sellVolumeWithCushion(10, 10, null);
    expect(v).toBeCloseTo(9.95, 6);
  });

  it('respects a custom cushionPct', () => {
    // 2% cushion.
    const v = sellVolumeWithCushion(100, 100, { baseMinSize: 0 }, 0.02);
    expect(v).toBeCloseTo(98, 6);
  });
});

describe('sellabilityBlocker', () => {
  it('returns null when both base and notional minimums are satisfied', () => {
    expect(
      sellabilityBlocker(0.5, 100, { baseMinSize: 0.1, quoteMinSize: 5 }),
    ).toBeNull();
  });

  it('returns null when no limits are known', () => {
    expect(sellabilityBlocker(0.0001, 0.01, null)).toBeNull();
  });

  it('blocks a buy whose post-fee base < baseMinSize', () => {
    // 0.099 after fees with base_min_size 0.1 → blocked.
    const reason = sellabilityBlocker(0.099, 100, { baseMinSize: 0.1 });
    expect(reason).not.toBeNull();
    expect(reason).toContain('0.09900000');
    expect(reason).toContain('venue min 0.1');
  });

  it('blocks a buy whose post-fee notional < quote_min_size (Coinbase)', () => {
    // 0.5 × $2 = $1.00 < $5 quote_min.
    const reason = sellabilityBlocker(0.5, 2, { baseMinSize: 0, quoteMinSize: 5 });
    expect(reason).not.toBeNull();
    expect(reason).toContain('$1.00');
    expect(reason).toContain('$5');
  });

  it('blocks a buy whose post-fee notional < minNotional (Binance)', () => {
    const reason = sellabilityBlocker(0.5, 2, { baseMinSize: 0, minNotional: 10 });
    expect(reason).not.toBeNull();
    expect(reason).toContain('$10');
  });

  it('uses the max when both quoteMinSize and minNotional are present', () => {
    // Should use the larger of the two.
    const reason = sellabilityBlocker(1, 6, { baseMinSize: 0, quoteMinSize: 5, minNotional: 10 });
    expect(reason).not.toBeNull();
    expect(reason).toContain('$10');
  });

  it('rejects non-positive base or price', () => {
    expect(sellabilityBlocker(0, 100, { baseMinSize: 0.1 })).toMatch(/non-positive/);
    expect(sellabilityBlocker(1, 0, { baseMinSize: 0.1 })).toMatch(/non-positive/);
  });

  it('passes the live RAVE-USD scenario: 0.1 base × $18.68 ≈ $1.87 with base_min_size 0.1', () => {
    // This is the scenario from the user's logs. With baseMin=0.1 and
    // no quote_min specified, the buy pre-flight should pass.
    expect(sellabilityBlocker(0.1, 18.68, { baseMinSize: 0.1 })).toBeNull();
  });

  it('rejects RAVE-USD if quote_min_size is $5 (would strand the position)', () => {
    // With Coinbase's typical $1 minimum — passes. With $5 — blocked.
    expect(sellabilityBlocker(0.1, 18.68, { baseMinSize: 0.1, quoteMinSize: 1 })).toBeNull();
    expect(sellabilityBlocker(0.1, 18.68, { baseMinSize: 0.1, quoteMinSize: 5 })).not.toBeNull();
  });
});
