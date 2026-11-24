/** Series transforms for charts: level, indexed to 100, year-over-year %, drawdown, ratio and spread. */
import type { ChartBlock, Series } from './types.js';

export type Transform = 'level' | 'indexed' | 'yoy' | 'drawdown';
export const TRANSFORMS: Transform[] = ['level', 'indexed', 'yoy', 'drawdown'];
export const TRANSFORM_LABEL: Record<Transform, string> = {
  level: 'Level',
  indexed: 'Indexed (start = 100)',
  yoy: 'YoY %',
  drawdown: 'Drawdown %',
};

type Points = [number, number][];
const YEAR_MS = 365.25 * 86_400_000;

/** Rebase so the first point is 100. */
export function indexed(points: Points): Points {
  const base = points.find(([, y]) => Number.isFinite(y) && y !== 0)?.[1];
  if (base === undefined) return [];
  return points.map(([x, y]) => [x, (y / base) * 100]);
}

/** Percent change against the value one year earlier (nearest earlier point within 20 days). */
export function yoy(points: Points): Points {
  const out: Points = [];
  let j = 0;
  for (let i = 0; i < points.length; i++) {
    const target = points[i][0] - YEAR_MS;
    if (target < points[0][0]) continue;
    while (j + 1 < i && points[j + 1][0] <= target) j++;
    const [tx, ty] = points[j];
    if (Math.abs(tx - target) <= 20 * 86_400_000 && ty !== 0) out.push([points[i][0], ((points[i][1] - ty) / Math.abs(ty)) * 100]);
  }
  return out;
}

/** Percent below the running peak (0 at a new high). */
export function drawdown(points: Points): Points {
  let peak = -Infinity;
  return points.map(([x, y]) => {
    peak = Math.max(peak, y);
    return [x, peak > 0 ? (y / peak - 1) * 100 : 0];
  });
}

/** Simple moving average over `window` points; the first `window - 1` points are dropped. */
export function sma(points: Points, window: number): Points {
  const out: Points = [];
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i][1];
    if (i >= window) sum -= points[i - window][1];
    if (i >= window - 1) out.push([points[i][0], sum / window]);
  }
  return out;
}

/** Combine two series on their common x values. */
export function combine(a: Points, b: Points, f: (a: number, b: number) => number): Points {
  const other = new Map(b);
  const out: Points = [];
  for (const [x, y] of a) {
    const z = other.get(x);
    if (z !== undefined) {
      const v = f(y, z);
      if (Number.isFinite(v)) out.push([x, v]);
    }
  }
  return out;
}

export function applyTransform(points: Points, t: Transform): Points {
  switch (t) {
    case 'indexed':
      return indexed(points);
    case 'yoy':
      return yoy(points);
    case 'drawdown':
      return drawdown(points);
    default:
      return points;
  }
}

/** A time chart with every series transformed. Other chart kinds are returned unchanged. */
export function transformChart(block: ChartBlock, t: Transform): ChartBlock {
  if (t === 'level' || block.xType !== 'time' || block.style === 'bar') return block;
  const series: Series[] = block.series.map((s) => ({ name: s.name, points: applyTransform(s.points, t) }));
  return {
    ...block,
    title: block.title ? `${block.title} (${TRANSFORM_LABEL[t]})` : TRANSFORM_LABEL[t],
    series,
    yFormat: t === 'indexed' ? 'num' : 'pct',
    yDigits: t === 'indexed' ? 1 : 1,
  };
}
