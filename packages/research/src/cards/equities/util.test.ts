import { describe, expect, it } from 'vitest';
import type { Bar } from '../../lib/market.js';
import { align, annualVol, beta, correlation, dailyReturns, longDate, maxDrawdown, median, parseValueTable, pct, percentile, rowOf, safeDiv, stdev, symbolList, totalReturn, usDate } from './util.js';

const bars = (closes: number[]): Bar[] => closes.map((c, i) => ({ t: (i + 1) * 86_400_000, o: c, h: c, l: c, c, v: null }));

describe('text helpers', () => {
  it('splits symbol lists', () => {
    expect(symbolList(' aapl, msft;GOOG aapl ')).toEqual(['AAPL', 'MSFT', 'GOOG']);
    expect(symbolList(undefined)).toEqual([]);
  });
  it('normalises provider dates', () => {
    expect(usDate('11/2/2026')).toBe('2026-11-02');
    expect(usDate('N/A')).toBe('');
    expect(longDate('Nov 12, 2026')).toBe('2026-11-12');
    expect(longDate('09/30/2026')).toBe('2026-09-30');
  });
});

describe('statement tables', () => {
  const t = parseValueTable(
    {
      headers: { value1: 'Period Ending:', value2: '9/26/2026', value3: '9/27/2025' },
      rows: [
        { value1: 'Total Revenue', value2: '$478,834,000', value3: '$416,161,000' },
        { value1: 'Operating Expenses', value2: '', value3: '' },
        { value1: "Add'l income/expense items", value2: '-$321,000', value3: '--' },
        { value1: 'Current Ratio', value2: '102.31998%', value3: '89.32929%' },
      ],
    },
    1000,
  );
  it('scales thousands, keeps percentages and marks headings', () => {
    expect(t.periods).toEqual(['2026-09-26', '2025-09-27']);
    expect(rowOf(t, 'total revenue')).toEqual([478_834_000_000, 416_161_000_000]);
    expect(t.rows[1].heading).toBe(true);
    expect(t.rows[2].values).toEqual([-321_000_000, null]);
    expect(rowOf(t, /current ratio/i)[0]).toBeCloseTo(102.31998);
    expect(rowOf(t, 'Missing')).toEqual([null, null]);
  });
});

describe('statistics', () => {
  it('median and percentile ignore missing values', () => {
    expect(median([3, null, 1, 2, undefined])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 10)).toBeCloseTo(14);
    expect(percentile([1, null], 90)).toBe(1);
  });
  it('sample standard deviation', () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(Number.isNaN(stdev([1]))).toBe(true);
  });
  it('returns, drawdown and total return', () => {
    const b = bars([100, 110, 99, 120, 90]);
    expect([...dailyReturns(b).values()].map((r) => Number(r.toFixed(4)))).toEqual([0.1, -0.1, 0.2121, -0.25]);
    expect(maxDrawdown(b)).toBeCloseTo(-25);
    expect(maxDrawdown(bars([1, 2, 3]))).toBe(0);
    expect(totalReturn(b)).toBeCloseTo(-10);
    expect(totalReturn(bars([5]))).toBeNull();
  });
  it('beta and correlation of a scaled series', () => {
    const x = [0.01, -0.02, 0.03, 0.005, -0.01];
    const y = x.map((v) => 2 * v + 0.001);
    expect(beta(x, y)).toBeCloseTo(2);
    expect(correlation(x, y)).toBeCloseTo(1);
    expect(correlation(x, x.map((v) => -v))).toBeCloseTo(-1);
    expect(correlation([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(beta([1], [1])).toBeNull();
  });
  it('aligns on common days only', () => {
    const a = new Map([[1, 0.1], [2, 0.2], [3, 0.3]]);
    const b = new Map([[2, 0.5], [3, 0.6], [4, 0.7]]);
    expect(align(a, b)).toEqual({ x: [0.2, 0.3], y: [0.5, 0.6] });
  });
  it('annualises volatility in percent', () => {
    expect(annualVol([0.01, -0.01, 0.01, -0.01])).toBeCloseTo(stdev([0.01, -0.01, 0.01, -0.01]) * Math.sqrt(252) * 100);
    expect(annualVol([0.01])).toBeNull();
  });
  it('guards division', () => {
    expect(safeDiv(1, 0)).toBeNull();
    expect(safeDiv(null, 2)).toBeNull();
    expect(pct(1, 4)).toBe(25);
  });
});
