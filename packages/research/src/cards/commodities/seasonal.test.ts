import { describe, expect, it } from 'vitest';
import { seasonalBand, seasonalChart, seasonalPosition, weekOfYear } from './seasonal.js';
import type { Point } from './util.js';

const day = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d);

describe('weekOfYear', () => {
  it('counts seven-day blocks from 1 January and folds the tail into week 52', () => {
    expect(weekOfYear(day(2024, 1, 1))).toBe(1);
    expect(weekOfYear(day(2024, 1, 7))).toBe(1);
    expect(weekOfYear(day(2024, 1, 8))).toBe(2);
    expect(weekOfYear(day(2024, 12, 23))).toBe(52);
    expect(weekOfYear(day(2024, 12, 31))).toBe(52); // day 366 of a leap year
    expect(weekOfYear(day(2023, 12, 31))).toBe(52);
  });
});

describe('seasonalBand', () => {
  // One reading in week 2 and one in week 10 for each of 2019..2025; value = year offset + slot marker.
  const points: Point[] = [];
  for (let y = 2019; y <= 2025; y++) {
    points.push([day(y, 1, 10), (y - 2019) * 10 + 100]);
    if (y < 2025) points.push([day(y, 3, 6), (y - 2019) * 10 + 200]);
  }

  it('uses the five years before the current one, not the current year or older ones', () => {
    const band = seasonalBand(points);
    expect(band.year).toBe(2025);
    expect(band.years).toEqual([2020, 2021, 2022, 2023, 2024]);
    const w2 = band.rows[1];
    expect(w2.slot).toBe(2);
    expect(w2.min).toBe(110); // 2020
    expect(w2.max).toBe(150); // 2024
    expect(w2.avg).toBe(130);
    expect(w2.current).toBe(160);
    expect(w2.prior).toBe(150);
    expect(w2.n).toBe(5);
  });

  it('leaves the current year empty for weeks not reached, and tracks the latest reading', () => {
    const band = seasonalBand(points);
    const w10 = band.rows[9];
    expect(w10.current).toBeNull();
    expect(w10.avg).toBe(230);
    expect(band.latest?.slot).toBe(2);
    expect(band.rows[30]).toMatchObject({ min: null, max: null, avg: null, current: null, n: 0 });
  });

  it('measures the latest reading against its band', () => {
    const pos = seasonalPosition(seasonalBand(points));
    expect(pos.vsAvg).toBe(30);
    expect(pos.vsAvgPct).toBeCloseTo((30 / 130) * 100, 10);
    expect(pos.inRangePct).toBeCloseTo(125, 10); // above the five-year high
  });

  it('keeps the last observation when a week has several, and honours an explicit year and lookback', () => {
    const band = seasonalBand(
      [
        [day(2023, 1, 1), 1],
        [day(2023, 1, 5), 2],
        [day(2024, 1, 3), 8],
        [day(2025, 1, 2), 5],
      ],
      { year: 2025, lookback: 2 },
    );
    expect(band.years).toEqual([2023, 2024]);
    expect(band.rows[0]).toMatchObject({ min: 2, max: 8, avg: 5, current: 5 });
  });

  it('supports monthly slots', () => {
    const band = seasonalBand(
      [
        [day(2023, 3, 1), 10],
        [day(2024, 3, 1), 30],
        [day(2025, 3, 1), 25],
      ],
      { period: 'month' },
    );
    expect(band.rows).toHaveLength(12);
    expect(band.rows[2]).toMatchObject({ slot: 3, min: 10, max: 30, avg: 20, current: 25 });
  });

  it('builds a four-line chart on the slot axis', () => {
    const chart = seasonalChart(seasonalBand(points), 'Stocks');
    expect(chart.xType).toBe('number');
    expect(chart.series.map((s) => s.name)).toEqual(['2025', 'Average 2020-2024', 'High', 'Low']);
    expect(chart.series[0].points).toEqual([[2, 160]]);
    expect(chart.series[1].points).toEqual([
      [2, 130],
      [10, 230],
    ]);
  });

  it('handles an empty series', () => {
    const band = seasonalBand([], { year: 2025 });
    expect(band.years).toEqual([]);
    expect(band.latest).toBeUndefined();
    expect(seasonalPosition(band)).toEqual({ vsAvg: null, vsAvgPct: null, inRangePct: null });
  });
});
