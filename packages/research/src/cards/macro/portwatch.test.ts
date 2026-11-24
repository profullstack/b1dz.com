import { describe, expect, it } from 'vitest';
import { arcDate, findChokepoint, smoothed, summariseTransits, toTransits, windowMean, ymd, type DailyTransits } from './portwatch.js';

const DAY = 86_400_000;
const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

function run(start: string, totals: number[], portid = 'chokepoint1'): DailyTransits[] {
  return totals.map((n, i) => ({ t: day(start) + i * DAY, portid, n_total: n, n_tanker: n / 2, n_container: n / 4, n_dry_bulk: n / 4 }));
}

describe('arcDate', () => {
  it('reads date-only strings and epoch timestamps', () => {
    expect(arcDate('2026-11-20')).toBe(Date.UTC(2026, 10, 20));
    expect(arcDate(1786744701000)).toBe(1786744701000);
    expect(arcDate(null)).toBeNull();
    expect(arcDate('20 Nov')).toBeNull();
  });
  it('round-trips through ymd', () => {
    expect(ymd(arcDate('2024-02-29') as number)).toBe('2024-02-29');
  });
});

describe('toTransits', () => {
  it('maps feature attributes, sorts by date and treats missing counts as zero', () => {
    const rows = toTransits([
      { date: '2026-11-02', portid: 'chokepoint6', n_total: 90, n_tanker: 40, n_container: 10, n_dry_bulk: 20 },
      { date: '2026-11-01', portid: 'chokepoint6', n_total: 80, n_tanker: null, n_container: 12, n_dry_bulk: 18 },
      { date: null, portid: 'chokepoint6', n_total: 1 },
    ]);
    expect(rows).toEqual([
      { t: day('2026-11-01'), portid: 'chokepoint6', n_total: 80, n_tanker: 0, n_container: 12, n_dry_bulk: 18 },
      { t: day('2026-11-02'), portid: 'chokepoint6', n_total: 90, n_tanker: 40, n_container: 10, n_dry_bulk: 20 },
    ]);
  });
});

describe('windowMean', () => {
  const rows = run('2026-11-01', [10, 20, 30, 40, 50, 60, 70, 80]);
  it('averages the seven days ending at the given day, inclusive', () => {
    expect(windowMean(rows, 'n_total', day('2026-11-08'))).toBe(50); // 20..80
    expect(windowMean(rows, 'n_total', day('2026-11-07'))).toBe(40); // 10..70
    expect(windowMean(rows, 'n_tanker', day('2026-11-08'))).toBe(25);
  });
  it('uses whatever days exist in a short window and is null for an empty one', () => {
    expect(windowMean(rows, 'n_total', day('2026-11-02'))).toBe(15);
    expect(windowMean(rows, 'n_total', day('2025-01-01'))).toBeNull();
  });
});

describe('summariseTransits', () => {
  it('compares the latest week with the week 364 days earlier and with a baseline', () => {
    const end = day('2026-11-20');
    const now = run(ymd(end - 6 * DAY), [60, 60, 60, 60, 60, 60, 60]);
    const then = run(ymd(end - 364 * DAY - 6 * DAY), [80, 80, 80, 80, 80, 80, 80]);
    const s = summariseTransits([...then, ...now], 'n_total', end, 120);
    expect(s.latest).toBe(60);
    expect(s.yearAgo).toBe(80);
    expect(s.vsYearAgo).toBeCloseTo(-25, 10);
    expect(s.vsBaseline).toBeCloseTo(-50, 10);
  });
  it('leaves comparisons null when history or the baseline is missing', () => {
    const end = day('2026-11-20');
    const s = summariseTransits(run(ymd(end - 6 * DAY), [5, 5, 5, 5, 5, 5, 5]), 'n_total', end, null);
    expect(s).toEqual({ latest: 5, yearAgo: null, vsYearAgo: null, vsBaseline: null });
  });
});

describe('smoothed', () => {
  it('is a trailing mean that starts once a full window exists', () => {
    const pts = smoothed(run('2026-11-01', [7, 7, 7, 7, 7, 7, 7, 14, 21]), 'n_total');
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual([day('2026-11-07'), 7]);
    expect(pts[1][1]).toBe(8);
    expect(pts[2]).toEqual([day('2026-11-09'), 10]);
  });
});

describe('findChokepoint', () => {
  it('matches by name, part of a name or id, and defaults to Hormuz', () => {
    expect(findChokepoint('Suez Canal').id).toBe('chokepoint1');
    expect(findChokepoint('panama').id).toBe('chokepoint2');
    expect(findChokepoint('chokepoint7').name).toBe('Cape of Good Hope');
    expect(findChokepoint(undefined).name).toBe('Strait of Hormuz');
  });
  it('rejects an unknown name', () => {
    expect(() => findChokepoint('Narrows of Nowhere')).toThrow(/unknown chokepoint/);
  });
});
