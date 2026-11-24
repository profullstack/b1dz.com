import { describe, expect, it } from 'vitest';
import { changeOver, diffOver, monthsBefore, parseBls, yoySeries, type BlsObs } from './bls.js';

const body = {
  status: 'REQUEST_SUCCEEDED',
  message: [],
  Results: {
    series: [
      {
        seriesID: 'TEST1',
        data: [
          { year: '2025', period: 'M02', periodName: 'February', latest: 'true', value: '110.0', footnotes: [{}] },
          { year: '2025', period: 'M01', periodName: 'January', value: '108.0', footnotes: [{}] },
          { year: '2024', period: 'M13', periodName: 'Annual', value: '101.0', footnotes: [{}] },
          { year: '2024', period: 'M12', periodName: 'December', value: '-', footnotes: [{}] },
          { year: '2024', period: 'M02', periodName: 'February', value: '100.0', footnotes: [{}] },
          { year: '2024', period: 'M01', periodName: 'January', value: '1,000.5', footnotes: [{}] },
        ],
      },
      { seriesID: 'TESTQ', data: [{ year: '2025', period: 'Q03', value: '4.5' }, { year: '2025', period: 'Q05', value: '4.0' }] },
      { seriesID: 'EMPTY', data: [] },
    ],
  },
};

describe('parseBls', () => {
  const parsed = parseBls(body);
  it('returns each series oldest first without annual averages or missing values', () => {
    expect(parsed.get('TEST1')).toEqual([
      { t: Date.UTC(2024, 0, 1), value: 1000.5, period: '2024-01' },
      { t: Date.UTC(2024, 1, 1), value: 100, period: '2024-02' },
      { t: Date.UTC(2025, 0, 1), value: 108, period: '2025-01' },
      { t: Date.UTC(2025, 1, 1), value: 110, period: '2025-02' },
    ]);
  });
  it('reads quarterly periods', () => {
    expect(parsed.get('TESTQ')).toEqual([{ t: Date.UTC(2025, 6, 1), value: 4.5, period: '2025-Q3' }]);
  });
  it('keeps a series that has no data as an empty list', () => {
    expect(parsed.get('EMPTY')).toEqual([]);
    expect(parseBls({}).size).toBe(0);
  });
});

const monthly = (start: [number, number], values: (number | null)[]): BlsObs[] => {
  const out: BlsObs[] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const t = Date.UTC(start[0], start[1] - 1 + i, 1);
    const d = new Date(t);
    out.push({ t, value: v, period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` });
  });
  return out;
};

describe('change maths', () => {
  // Jan 2024 .. Feb 2025, with October 2024 missing (as after a data gap).
  const list = monthly([2024, 1], [100, 101, 102, 103, 104, 105, 106, 107, 108, null, 110, 111, 103, 106.05]);

  it('matches on the calendar month, not on position', () => {
    expect(monthsBefore(list, list.length - 1, 12)?.period).toBe('2024-02');
    expect(monthsBefore(list, list.length - 1, 1)?.period).toBe('2025-01');
    // November 2024's previous month is the missing October.
    const nov = list.findIndex((o) => o.period === '2024-11');
    expect(monthsBefore(list, nov, 1)).toBeUndefined();
  });

  it('computes percent and level changes', () => {
    expect(changeOver(list, 12)).toBeCloseTo(5, 10); // 106.05 vs 101
    expect(diffOver(list, 1)).toBeCloseTo(3.05, 10);
    expect(changeOver(list, 24)).toBeNull();
    expect(changeOver([], 12)).toBeNull();
  });

  it('builds a 12-month change series only where a year-ago value exists', () => {
    const y = yoySeries(list);
    expect(y).toHaveLength(2);
    expect(y[0][0]).toBe(Date.UTC(2025, 0, 1));
    expect(y[0][1]).toBeCloseTo(3, 10);
    expect(y[1][1]).toBeCloseTo(5, 10);
  });
});
