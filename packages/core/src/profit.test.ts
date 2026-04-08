import { describe, it, expect } from 'vitest';
import { profit, roi, expectedValue, score } from './profit.js';
import type { Opportunity } from './types.js';

const make = (over: Partial<Opportunity> = {}): Opportunity => ({
  id: 't:1',
  sourceId: 't',
  externalId: '1',
  title: 'test',
  costNow: 100,
  projectedReturn: 150,
  projectedProfit: 50,
  confidence: 0.8,
  metadata: {},
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('profit math', () => {
  it('profit subtracts cost from return', () => {
    expect(profit(make())).toBe(50);
  });

  it('roi divides profit by cost', () => {
    expect(roi(make())).toBeCloseTo(0.5);
  });

  it('roi handles zero cost', () => {
    expect(roi(make({ costNow: 0 }))).toBe(0);
  });

  it('expectedValue scales by confidence', () => {
    expect(expectedValue(make({ confidence: 0.5 }))).toBe(25);
  });

  it('score boosts opportunities expiring soon', () => {
    const now = Date.now();
    const soon = make({ expiresAt: now + 30 * 60_000 });
    const later = make({ expiresAt: now + 5 * 60 * 60_000 });
    expect(score(soon, now)).toBeGreaterThan(score(later, now));
  });

  it('score equals expectedValue when no expiry', () => {
    const o = make();
    expect(score(o)).toBeCloseTo(expectedValue(o));
  });
});
