/**
 * The five-year seasonal band: for weekly (or monthly) data, the minimum,
 * maximum and average for each week of the year over the previous five
 * calendar years, with the current year set against them. This is how
 * inventory reports are usually read: a level only means something relative
 * to what is normal for the time of year.
 */
import type { ChartBlock } from '../../types.js';
import type { Point } from './util.js';

export interface SeasonalRow {
  /** Week of year 1..52 (or month 1..12). */
  slot: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  /** Value in the current year, null for slots not reached yet. */
  current: number | null;
  /** Value in the year before the current one. */
  prior: number | null;
  /** How many of the reference years had a value for this slot. */
  n: number;
}

export interface SeasonalBand {
  year: number;
  /** The reference years, oldest first. */
  years: number[];
  period: 'week' | 'month';
  rows: SeasonalRow[];
  /** The last slot of the current year that has a value. */
  latest?: SeasonalRow;
}

/**
 * Week of year 1..52: days 1-7 are week 1, and so on. The one or two days
 * beyond day 364 are folded into week 52 so every year has the same slots.
 */
export function weekOfYear(ms: number): number {
  const d = new Date(ms);
  const dayOfYear = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000);
  return Math.min(52, Math.floor(dayOfYear / 7) + 1);
}

export interface SeasonalOptions {
  /** The year shown against the band. Default: the year of the last point. */
  year?: number;
  /** Reference years before `year`. Default 5. */
  lookback?: number;
  period?: 'week' | 'month';
}

export function seasonalBand(points: Point[], opts: SeasonalOptions = {}): SeasonalBand {
  const period = opts.period ?? 'week';
  const lookback = opts.lookback ?? 5;
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const year = opts.year ?? (sorted.length ? new Date(sorted[sorted.length - 1][0]).getUTCFullYear() : new Date().getUTCFullYear());
  const slots = period === 'week' ? 52 : 12;
  const slotOf = (ms: number): number => (period === 'week' ? weekOfYear(ms) : new Date(ms).getUTCMonth() + 1);

  // year -> slot -> value (the last observation in a slot wins)
  const byYear = new Map<number, Map<number, number>>();
  for (const [t, v] of sorted) {
    if (!Number.isFinite(v)) continue;
    const y = new Date(t).getUTCFullYear();
    let m = byYear.get(y);
    if (!m) byYear.set(y, (m = new Map()));
    m.set(slotOf(t), v);
  }
  const years = Array.from({ length: lookback }, (_, i) => year - lookback + i).filter((y) => byYear.has(y));
  const rows: SeasonalRow[] = [];
  let latest: SeasonalRow | undefined;
  for (let slot = 1; slot <= slots; slot++) {
    const ref: number[] = [];
    for (const y of years) {
      const v = byYear.get(y)?.get(slot);
      if (v !== undefined) ref.push(v);
    }
    const row: SeasonalRow = {
      slot,
      min: ref.length ? Math.min(...ref) : null,
      max: ref.length ? Math.max(...ref) : null,
      avg: ref.length ? ref.reduce((a, b) => a + b, 0) / ref.length : null,
      current: byYear.get(year)?.get(slot) ?? null,
      prior: byYear.get(year - 1)?.get(slot) ?? null,
      n: ref.length,
    };
    if (row.current !== null) latest = row;
    rows.push(row);
  }
  return { year, years, period, rows, latest };
}

/** The band as a chart: x is the week (or month) number; four lines. */
export function seasonalChart(band: SeasonalBand, title: string, yFormat: ChartBlock['yFormat'] = 'num', yDigits = 0): ChartBlock {
  const line = (pick: (r: SeasonalRow) => number | null): [number, number][] =>
    band.rows.flatMap((r) => {
      const v = pick(r);
      return v === null ? [] : [[r.slot, v] as [number, number]];
    });
  const span = band.years.length ? `${band.years[0]}-${band.years[band.years.length - 1]}` : 'no reference years';
  return {
    kind: 'chart',
    title,
    xType: 'number',
    xLabel: band.period === 'week' ? 'Week of year' : 'Month',
    yFormat,
    yDigits,
    series: [
      { name: String(band.year), points: line((r) => r.current) },
      { name: `Average ${span}`, points: line((r) => r.avg) },
      { name: 'High', points: line((r) => r.max) },
      { name: 'Low', points: line((r) => r.min) },
    ],
  };
}

/** Where the latest reading sits against its band, in the units of the data and in percent of the average. */
export function seasonalPosition(band: SeasonalBand): { vsAvg: number | null; vsAvgPct: number | null; inRangePct: number | null } {
  const r = band.latest;
  if (!r || r.current === null || r.avg === null || r.min === null || r.max === null) return { vsAvg: null, vsAvgPct: null, inRangePct: null };
  return {
    vsAvg: r.current - r.avg,
    vsAvgPct: r.avg !== 0 ? ((r.current - r.avg) / Math.abs(r.avg)) * 100 : null,
    inRangePct: r.max > r.min ? ((r.current - r.min) / (r.max - r.min)) * 100 : null,
  };
}
