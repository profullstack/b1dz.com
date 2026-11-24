import { describe, expect, it } from 'vitest';
import { crossChange, crossRate, crossSeries, currencyStrength, marketPair, parseFxPanel, strengthSeries } from './fx-data.js';
import { correlation, monthsBack, monthStartBack, percentile, periodMs, pointReturns, valueAt, type Point } from './util.js';

const d = (s: string): number => Date.parse(`${s}T00:00:00Z`);

// Units per U.S. dollar. Day 2: the euro gains 10% on the dollar, the yen loses 10%, sterling is flat.
const body = {
  base: 'USD',
  rates: {
    '2026-11-20': { EUR: 1.0, JPY: 100, GBP: 0.8 },
    '2026-11-23': { EUR: 1 / 1.1, JPY: 110, GBP: 0.8, CHF: 0.9 },
  },
};

describe('parseFxPanel', () => {
  const panel = parseFxPanel(body);

  it('orders dates and fills currencies missing on a day with NaN', () => {
    expect(panel.dates).toEqual([d('2026-11-20'), d('2026-11-23')]);
    expect(panel.perUsd.USD).toEqual([1, 1]);
    expect(panel.perUsd.JPY).toEqual([100, 110]);
    expect(panel.perUsd.CHF[0]).toBeNaN();
    expect(panel.perUsd.CHF[1]).toBe(0.9);
  });

  it('ignores junk', () => {
    expect(parseFxPanel({}).dates).toEqual([]);
    expect(parseFxPanel({ rates: { nope: { EUR: 1 }, '2026-01-02': { EUR: 'x', JPY: -1 } } }).perUsd).toEqual({ USD: [1] });
  });
});

describe('crosses', () => {
  const panel = parseFxPanel(body);

  it('prices one base currency in the quote currency', () => {
    expect(crossRate(panel, 'EUR', 'USD')).toBeCloseTo(1.1, 10);
    expect(crossRate(panel, 'USD', 'JPY')).toBe(110);
    expect(crossRate(panel, 'EUR', 'JPY')).toBeCloseTo(121, 10);
    expect(crossRate(panel, 'GBP', 'EUR')).toBeCloseTo(1 / 1.1 / 0.8, 10);
    expect(crossRate(panel, 'EUR', 'XXX')).toBeNull();
  });

  it('skips days a leg is missing', () => {
    expect(crossSeries(panel, 'USD', 'CHF')).toEqual([[d('2026-11-23'), 0.9]]);
  });

  it('measures the change in the base currency', () => {
    expect(crossChange(panel, 'EUR', 'USD', d('2026-11-20'))).toBeCloseTo(10, 10);
    expect(crossChange(panel, 'JPY', 'USD', d('2026-11-20'))).toBeCloseTo((100 / 110 - 1) * 100, 10);
    expect(crossChange(panel, 'USD', 'EUR', d('2026-11-20'))).toBeCloseTo((1 / 1.1 - 1) * 100, 10);
    expect(crossChange(panel, 'EUR', 'USD', d('2026-11-01'))).toBeNull(); // before the history starts
  });

  it('quotes pairs the way the market does', () => {
    expect(marketPair('EUR')).toEqual({ pair: 'EURUSD', inverted: true });
    expect(marketPair('JPY')).toEqual({ pair: 'USDJPY', inverted: false });
  });
});

describe('currencyStrength', () => {
  const panel = parseFxPanel(body);
  const set = ['USD', 'EUR', 'JPY', 'GBP'];
  const table = currencyStrength(panel, set, d('2026-11-20'));
  const row = (c: string) => table.find((r) => r.currency === c)!;

  it('averages the moves against the others and ranks strongest first', () => {
    expect(table.map((r) => r.currency)).toEqual(['EUR', 'USD', 'GBP', 'JPY']);
    // EUR: +10% vs USD, +21% vs JPY, +10% vs GBP
    expect(row('EUR').average).toBeCloseTo((10 + 21 + 10) / 3, 8);
    // USD: -9.09% vs EUR, +10% vs JPY, 0 vs GBP
    expect(row('USD').average).toBeCloseTo(((1 / 1.1 - 1) * 100 + 10 + 0) / 3, 8);
  });

  it('sets the move against the dollar alone beside it', () => {
    expect(row('EUR').vsUsd).toBeCloseTo(10, 8);
    expect(row('GBP').vsUsd).toBeCloseTo(0, 8);
    expect(row('USD').vsUsd).toBeNull();
    // Sterling did nothing against the dollar but its average is not zero: the others moved.
    expect(row('GBP').average).toBeCloseTo(((1 / 1.1 - 1) * 100 + 10 + 0) / 3, 8);
  });

  it('names the strongest and weakest counterparts', () => {
    expect(row('EUR').strongestAgainst).toBe('JPY');
    expect(row('JPY').weakestAgainst).toBe('EUR');
  });

  it('ends its time series on the same number as the table', () => {
    const s = strengthSeries(panel, set, 'EUR', d('2026-11-20'));
    expect(s[0]).toEqual([d('2026-11-20'), 0]);
    expect(s[s.length - 1][1]).toBeCloseTo(row('EUR').average as number, 8);
  });
});

describe('util', () => {
  it('parses provider periods', () => {
    expect(periodMs('2026')).toBe(Date.UTC(2026, 0, 1));
    expect(periodMs('2026-08')).toBe(Date.UTC(2026, 7, 1));
    expect(periodMs('2026-M10')).toBe(Date.UTC(2026, 9, 1));
    expect(periodMs('2026-Q3')).toBe(Date.UTC(2026, 6, 1));
    expect(periodMs('2026-11-17')).toBe(Date.UTC(2026, 10, 17));
    expect(periodMs('2026-11-24T13')).toBe(Date.UTC(2026, 10, 24, 13));
    expect(periodMs('soon')).toBeNaN();
  });

  it('steps months with end-of-month clamping', () => {
    expect(monthsBack(Date.UTC(2026, 2, 31), 1)).toBe(Date.UTC(2026, 1, 28));
    expect(monthsBack(Date.UTC(2026, 0, 15), 12)).toBe(Date.UTC(2025, 0, 15));
    expect(monthStartBack(new Date(Date.UTC(2026, 10, 24)), 13)).toBe('2025-10-01');
  });

  it('looks up the last value on or before a time', () => {
    const pts: Point[] = [
      [10, 1],
      [20, 2],
      [30, 3],
    ];
    expect(valueAt(pts, 5)).toBeNull();
    expect(valueAt(pts, 20)).toBe(2);
    expect(valueAt(pts, 29)).toBe(2);
    expect(valueAt(pts, 99)).toBe(3);
  });

  it('computes returns over the usual horizons', () => {
    const pts: Point[] = [
      [Date.UTC(2025, 10, 20), 80],
      [Date.UTC(2025, 11, 31), 100],
      [Date.UTC(2026, 7, 20), 125],
      [Date.UTC(2026, 9, 20), 110],
      [Date.UTC(2026, 10, 13), 120],
      [Date.UTC(2026, 10, 19), 99],
      [Date.UTC(2026, 10, 20), 110],
    ];
    const r = pointReturns(pts);
    expect(r.last).toBe(110);
    expect(r.prev).toBeCloseTo((110 / 99 - 1) * 100, 10);
    expect(r.w1).toBeCloseTo((110 / 120 - 1) * 100, 10);
    expect(r.m1).toBeCloseTo(0, 10);
    expect(r.m3).toBeCloseTo((110 / 125 - 1) * 100, 10);
    expect(r.ytd).toBeCloseTo(10, 10);
    expect(r.y1).toBeCloseTo((110 / 80 - 1) * 100, 10);
    expect(pointReturns([])).toMatchObject({ last: null, y1: null });
  });

  it('correlates and ranks', () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(correlation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
    expect(correlation([1, 2], [1, 2])).toBeNull();
    expect(correlation([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(percentile([1, 2, 3, 4], 2)).toBe(50);
    expect(percentile([], 2)).toBeNull();
  });
});
