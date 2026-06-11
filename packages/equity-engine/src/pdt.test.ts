import { describe, it, expect } from 'vitest';
import { countRecentDayTrades, isPdtRestricted, wouldExceedPdt } from './pdt.js';

const DAY = 24 * 60 * 60 * 1000;

describe('countRecentDayTrades', () => {
  it('counts only trades within the trailing 5 days', () => {
    const now = Date.now();
    const ts = [now - 1 * DAY, now - 2 * DAY, now - 4 * DAY, now - 6 * DAY, now - 10 * DAY];
    expect(countRecentDayTrades(ts, now)).toBe(3);
  });

  it('is zero for an empty history', () => {
    expect(countRecentDayTrades([])).toBe(0);
  });
});

describe('isPdtRestricted', () => {
  it('restricts sub-$25k, not at/above', () => {
    expect(isPdtRestricted(24_999)).toBe(true);
    expect(isPdtRestricted(25_000)).toBe(false);
    expect(isPdtRestricted(undefined)).toBe(false);
  });
});

describe('wouldExceedPdt', () => {
  it('blocks the 4th day trade for a restricted account', () => {
    expect(wouldExceedPdt(3, 10_000)).toBe(true);
    expect(wouldExceedPdt(2, 10_000)).toBe(false);
  });
  it('never blocks a $25k+ account', () => {
    expect(wouldExceedPdt(9, 50_000)).toBe(false);
  });
});
