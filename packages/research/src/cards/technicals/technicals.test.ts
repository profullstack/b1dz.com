import { describe, expect, it } from 'vitest';
import type { Bar } from '../../lib/market.js';
import { fibonacci, levels, macd, pivots, rsi, smaLast, trendlines } from './analysis.js';
import { candlesAt, candlestickPatterns } from './candles.js';
import { chartPatterns } from './patterns.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

/** Bars from a list of closes: each opens at the previous close, wicks 0.2 beyond the body. */
function fromCloses(closes: number[], wick = 0.2): Bar[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { t: T0 + i * DAY, o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 1000 };
  });
}

/** Closes walking in straight lines through waypoints, `steps` bars per leg. */
function path(points: number[], steps = 6): number[] {
  const out: number[] = [points[0]];
  for (let p = 1; p < points.length; p++) {
    for (let s = 1; s <= steps; s++) out.push(points[p - 1] + ((points[p] - points[p - 1]) * s) / steps);
  }
  return out;
}

const bar = (i: number, o: number, h: number, l: number, c: number): Bar => ({ t: T0 + i * DAY, o, h, l, c, v: 1 });

describe('indicators', () => {
  it('computes SMA, RSI and MACD', () => {
    expect(smaLast([1, 2, 3, 4], 2)).toBe(3.5);
    expect(smaLast([1], 2)).toBeNull();
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(rsi(rising)).toBe(100);
    expect(rsi(rising.map((x) => 200 - x))).toBeLessThan(1);
    expect(macd(rising)!.macd).toBeGreaterThan(0);
    expect(macd([1, 2, 3])).toBeNull();
  });
});

describe('pivots and levels', () => {
  const closes = path([100, 110, 100, 110, 100, 110, 100, 105]);
  const bars = fromCloses(closes);

  it('finds the swing highs and lows', () => {
    const p = pivots(bars, 2);
    expect(p.filter((x) => x.kind === 'high').length).toBe(3);
    expect(p.filter((x) => x.kind === 'low').length).toBeGreaterThanOrEqual(3);
  });

  it('clusters a range into support and resistance', () => {
    const lv = levels(bars, pivots(bars, 2));
    const res = lv.find((l) => l.kind === 'resistance')!;
    const sup = lv.find((l) => l.kind === 'support')!;
    expect(res.price).toBeCloseTo(110.2, 1);
    expect(res.touches).toBe(3);
    expect(sup.price).toBeCloseTo(99.8, 1);
    expect(sup.touches).toBeGreaterThanOrEqual(3);
    expect(res.distancePct).toBeGreaterThan(0);
    expect(sup.distancePct).toBeLessThan(0);
  });
});

describe('trendlines', () => {
  it('draws a rising support line through higher lows', () => {
    // Higher lows at 100, 104, 108, 112 with highs 10 above each.
    const bars = fromCloses(path([100, 110, 104, 114, 108, 118, 112, 122, 117]));
    const lines = trendlines(bars, pivots(bars, 2));
    const sup = lines.find((l) => l.kind === 'support')!;
    expect(sup).toBeDefined();
    expect(sup.touches).toBeGreaterThanOrEqual(3);
    expect(sup.slopePctPerDay).toBeGreaterThan(0);
    expect(sup.status).toBe('holding');
    const res = lines.find((l) => l.kind === 'resistance')!;
    expect(res.slopePctPerDay).toBeGreaterThan(0);
  });

  it('reports a fresh break of support', () => {
    const bars = fromCloses([...path([100, 110, 104, 114, 108, 118, 112, 122]), 118, 114, 109]);
    const sup = trendlines(bars, pivots(bars, 2)).find((l) => l.kind === 'support')!;
    expect(sup.status).toBe('broken');
  });
});

describe('fibonacci', () => {
  it('measures a retracement of a rally from the high down', () => {
    const bars = fromCloses(path([100, 200, 162], 10), 0);
    const f = fibonacci(bars)!;
    expect(f.direction).toBe('up');
    expect(f.levels.find((l) => l.ratio === 0.382)!.price).toBeCloseTo(161.8, 1);
    expect(f.nearest.ratio).toBe(0.382);
    expect(f.levels.find((l) => l.ratio === 1.618)!.price).toBeCloseTo(261.8, 1);
  });

  it('measures a decline from the low up', () => {
    const f = fibonacci(fromCloses(path([200, 100, 150], 10), 0))!;
    expect(f.direction).toBe('down');
    expect(f.levels.find((l) => l.ratio === 0.5)!.price).toBeCloseTo(150, 5);
  });
});

describe('candlestick patterns', () => {
  /** Seven falling bars (a downtrend into the last one), then the given bars. */
  const downtrend = (): Bar[] => Array.from({ length: 7 }, (_, i) => bar(i, 120 - i * 3, 121 - i * 3, 116 - i * 3, 117 - i * 3));
  const names = (bars: Bar[]) => candlesAt(bars, bars.length - 1).map((h) => h.pattern);

  it('finds a hammer after a decline', () => {
    const bars = [...downtrend(), bar(7, 99, 100.5, 94, 100.2)];
    expect(names(bars)).toContain('Hammer');
  });

  it('finds a bullish engulfing bar', () => {
    const bars = [...downtrend(), bar(7, 100, 100.5, 97.5, 98), bar(8, 97.5, 101.5, 97, 101)];
    expect(names(bars)).toContain('Bullish engulfing');
  });

  it('finds a morning star', () => {
    const bars = [...downtrend(), bar(7, 100, 100.5, 95, 95.5), bar(8, 95, 95.6, 94, 94.8), bar(9, 95, 99.5, 94.9, 99)];
    expect(names(bars)).toContain('Morning star');
  });

  it('finds three white soldiers', () => {
    const bars = [...downtrend(), bar(7, 100, 103.2, 99.8, 103), bar(8, 102, 105.2, 101.8, 105), bar(9, 104, 107.2, 103.8, 107)];
    expect(names(bars)).toContain('Three white soldiers');
  });

  it('finds a doji and lists hits newest first', () => {
    const bars = [...downtrend(), bar(7, 100, 103, 97, 100.05)];
    expect(names(bars)).toContain('Doji');
    const all = candlestickPatterns(bars);
    expect(all[0].i).toBe(bars.length - 1);
  });
});

describe('chart patterns', () => {
  it('finds a confirmed double top with its measured target', () => {
    const bars = fromCloses(path([90, 100, 120, 100, 120, 92]), 0.2);
    const p = chartPatterns(bars, pivots(bars, 2)).find((x) => x.pattern === 'Double top')!;
    expect(p).toBeDefined();
    expect(p.status).toBe('confirmed');
    expect(p.bias).toBe('bearish');
    expect(p.trigger).toBeCloseTo(99.8, 1);
    expect(p.target!).toBeLessThan(p.trigger);
  });

  it('finds a double bottom still forming', () => {
    const bars = fromCloses(path([130, 120, 100, 120, 100, 112]), 0.2);
    const p = chartPatterns(bars, pivots(bars, 2)).find((x) => x.pattern === 'Double bottom')!;
    expect(p.status).toBe('forming');
    expect(p.bias).toBe('bullish');
  });

  it('finds a head and shoulders', () => {
    const bars = fromCloses(path([90, 100, 115, 105, 125, 105, 115, 95]), 0.2);
    const p = chartPatterns(bars, pivots(bars, 2)).find((x) => x.pattern === 'Head and shoulders')!;
    expect(p).toBeDefined();
    expect(p.status).toBe('confirmed');
    expect(p.target!).toBeLessThan(p.trigger);
  });

  it('finds an ascending triangle', () => {
    const bars = fromCloses(path([95, 90, 110, 95, 110, 100, 110, 104, 110, 107], 5), 0.2);
    const p = chartPatterns(bars, pivots(bars, 2)).find((x) => x.pattern === 'Ascending triangle')!;
    expect(p).toBeDefined();
    expect(p.bias).toBe('bullish');
    expect(p.lines).toHaveLength(2);
  });
});
