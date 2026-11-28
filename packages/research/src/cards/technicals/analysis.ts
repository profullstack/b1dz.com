/**
 * Automated technical analysis over daily bars: indicators, swing pivots,
 * support and resistance levels, trendlines and Fibonacci retracements.
 *
 * Pure functions, no I/O: the cards in ./index.ts fetch the bars and render
 * what these return. Every rule is deterministic and documented here so the
 * same bars always give the same lines.
 */
import type { Bar } from '../../lib/market.js';

export type Bias = 'bullish' | 'bearish' | 'neutral';

// ------------------------------------------------------------ indicators

/** Simple moving average of the last `period` values, or null when there are too few. */
export function smaLast(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

/** Exponential moving average, one value per input (seeded with the first value). */
export function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

/** Wilder's RSI of the latest value, or null with fewer than period + 1 values. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** MACD(12, 26, 9) of the latest value. */
export function macd(values: number[], fast = 12, slow = 26, signal = 9): { macd: number; signal: number; hist: number } | null {
  if (values.length < slow + signal) return null;
  const f = emaSeries(values, fast);
  const s = emaSeries(values, slow);
  const line = values.map((_, i) => f[i] - s[i]);
  const sig = emaSeries(line.slice(slow - 1), signal);
  const m = line[line.length - 1];
  const g = sig[sig.length - 1];
  return { macd: m, signal: g, hist: m - g };
}

/** True range of each bar (the first bar uses its own high minus low). */
export function trueRanges(bars: Bar[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const pc = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  });
}

/** Average true range of the last `period` bars. */
export function atr(bars: Bar[], period = 14): number {
  const tr = trueRanges(bars);
  const tail = tr.slice(-period);
  return tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 0;
}

/** Rolling ATR, one value per bar (the mean of up to `period` true ranges ending there). */
export function atrSeries(bars: Bar[], period = 14): number[] {
  const tr = trueRanges(bars);
  const out: number[] = [];
  let sum = 0;
  tr.forEach((v, i) => {
    sum += v;
    if (i >= period) sum -= tr[i - period];
    out.push(sum / Math.min(i + 1, period));
  });
  return out;
}

/**
 * How close two prices must be to count as "the same level": half an ATR,
 * and never less than 0.4% of the last close (so a calm market still clusters).
 */
export function tolerance(bars: Bar[]): number {
  const last = bars[bars.length - 1]?.c ?? 0;
  return Math.max(atr(bars) * 0.5, Math.abs(last) * 0.004);
}

// ------------------------------------------------------------ pivots

export interface Pivot {
  i: number;
  t: number;
  price: number;
  kind: 'high' | 'low';
}

/** Bars each side a swing must dominate: about one per 50 bars, between 2 and 8. */
export function pivotWindow(n: number): number {
  return Math.min(8, Math.max(2, Math.round(n / 50)));
}

/**
 * Swing highs and lows. A bar is a swing high when its high is above every
 * high in the `k` bars before it and at least every high in the `k` bars
 * after it (so a flat top yields one pivot, its first bar). Lows mirror that.
 * The last `k` bars cannot be confirmed yet and never pivot.
 */
export function pivots(bars: Bar[], k = pivotWindow(bars.length)): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let hi = true;
    let lo = true;
    for (let j = i - k; j <= i + k && (hi || lo); j++) {
      if (j === i) continue;
      if (j < i ? bars[j].h >= bars[i].h : bars[j].h > bars[i].h) hi = false;
      if (j < i ? bars[j].l <= bars[i].l : bars[j].l < bars[i].l) lo = false;
    }
    if (hi) out.push({ i, t: bars[i].t, price: bars[i].h, kind: 'high' });
    if (lo) out.push({ i, t: bars[i].t, price: bars[i].l, kind: 'low' });
  }
  return out;
}

/** Pivots reduced to an alternating high/low sequence, keeping the more extreme of any run. */
export function alternating(piv: Pivot[]): Pivot[] {
  const out: Pivot[] = [];
  for (const p of [...piv].sort((a, b) => a.i - b.i || (a.kind === 'high' ? -1 : 1))) {
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) {
      if ((p.kind === 'high' && p.price > last.price) || (p.kind === 'low' && p.price < last.price)) out[out.length - 1] = p;
    } else out.push(p);
  }
  return out;
}

// ------------------------------------------------------------ levels

export interface Level {
  price: number;
  /** Swing highs and lows that formed it. */
  touches: number;
  firstT: number;
  lastT: number;
  kind: 'support' | 'resistance';
  /** Percent from the last close to the level (negative: below). */
  distancePct: number;
}

/**
 * Horizontal support and resistance: swing prices clustered within the
 * tolerance. Clusters of two or more swings rank by touches, then recency.
 * Returns up to `max` levels, highest price first; when the market has made
 * fewer than two repeated levels, single swings fill in, most recent first.
 */
export function levels(bars: Bar[], piv = pivots(bars), max = 6): Level[] {
  if (!bars.length || !piv.length) return [];
  const tol = tolerance(bars);
  const last = bars[bars.length - 1].c;
  const sorted = [...piv].sort((a, b) => a.price - b.price);
  const clusters: Pivot[][] = [];
  for (const p of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(p.price - c.reduce((s, x) => s + x.price, 0) / c.length) <= tol) c.push(p);
    else clusters.push([p]);
  }
  const n = bars.length;
  const scored = clusters.map((c) => {
    const price = c.reduce((s, x) => s + x.price, 0) / c.length;
    const lastI = Math.max(...c.map((x) => x.i));
    return {
      level: {
        price,
        touches: c.length,
        firstT: Math.min(...c.map((x) => x.t)),
        lastT: Math.max(...c.map((x) => x.t)),
        kind: price <= last ? 'support' : 'resistance',
        distancePct: last ? ((price - last) / last) * 100 : 0,
      } as Level,
      score: c.length + lastI / n,
    };
  });
  const repeated = scored.filter((s) => s.level.touches >= 2).sort((a, b) => b.score - a.score);
  const singles = scored.filter((s) => s.level.touches < 2).sort((a, b) => b.level.lastT - a.level.lastT);
  const pick = repeated.length >= 2 ? repeated.slice(0, max) : [...repeated, ...singles].slice(0, max);
  return pick.map((s) => s.level).sort((a, b) => b.price - a.price);
}

// ------------------------------------------------------------ trendlines

export interface Trendline {
  kind: 'support' | 'resistance';
  /** The two swing points the line is drawn through. */
  a: Pivot;
  b: Pivot;
  /** Swings of the same kind within tolerance of the line (a and b included). */
  touches: number;
  /** Line value at the last bar. */
  valueNow: number;
  /** Slope in percent of the current line value per trading day. */
  slopePctPerDay: number;
  /**
   * holding: price is on the right side of the line; testing: within the
   * tolerance of it; broken: the last close is through it (a breakdown of
   * support or a breakout above resistance, in the last three bars).
   */
  status: 'holding' | 'testing' | 'broken';
}

/** Value of the line through a and b at bar index i. */
export function lineAt(a: { i: number; price: number }, b: { i: number; price: number }, i: number): number {
  return a.price + ((b.price - a.price) * (i - a.i)) / (b.i - a.i);
}

/**
 * The strongest support line (through swing lows) and resistance line
 * (through swing highs). Every pair of recent swings is a candidate; a
 * candidate survives when no close crossed it by more than the tolerance from
 * its first swing up to three bars ago (a fresh break in the last three bars
 * is reported as `broken` rather than discarded), and when it ends within
 * max(8 ATR, 20%) of the last close. Survivors rank by touches,
 * then by how recent and how long they are.
 */
export function trendlines(bars: Bar[], piv = pivots(bars)): Trendline[] {
  const n = bars.length;
  if (n < 10) return [];
  const tol = tolerance(bars);
  const k = pivotWindow(n);
  const far = Math.max(atr(bars) * 8, Math.abs(bars[n - 1].c) * 0.2);
  const out: Trendline[] = [];
  for (const kind of ['support', 'resistance'] as const) {
    const side = piv.filter((p) => p.kind === (kind === 'support' ? 'low' : 'high')).slice(-12);
    let best: { line: Trendline; score: number } | null = null;
    for (let x = 0; x < side.length; x++) {
      for (let y = x + 1; y < side.length; y++) {
        const a = side[x];
        const b = side[y];
        if (b.i - a.i < 2 * k) continue;
        const checkTo = Math.max(b.i, n - 4);
        let ok = true;
        for (let i = a.i; i <= checkTo && ok; i++) {
          const v = lineAt(a, b, i);
          if (kind === 'support' ? bars[i].c < v - tol : bars[i].c > v + tol) ok = false;
        }
        if (!ok) continue;
        const valueNow = lineAt(a, b, n - 1);
        const c = bars[n - 1].c;
        // A line that has run far from the price (a steep line the market left behind) is no longer in play.
        if (Math.abs(valueNow - c) > far) continue;
        const touches = side.filter((p) => p.i >= a.i && Math.abs(p.price - lineAt(a, b, p.i)) <= tol).length;
        const score = touches * 10 + (b.i / n) * 5 + ((n - a.i) / n) * 3;
        if (best && score <= best.score) continue;
        const through = kind === 'support' ? c < valueNow - tol : c > valueNow + tol;
        const status: Trendline['status'] = through ? 'broken' : Math.abs(c - valueNow) <= tol ? 'testing' : 'holding';
        const perBar = (b.price - a.price) / (b.i - a.i);
        best = {
          score,
          line: { kind, a, b, touches, valueNow, slopePctPerDay: valueNow ? (perBar / Math.abs(valueNow)) * 100 : 0, status },
        };
      }
    }
    if (best) out.push(best.line);
  }
  return out;
}

// ------------------------------------------------------------ fibonacci

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
export const FIB_EXTENSIONS = [1.272, 1.618];

export interface FibLevel {
  ratio: number;
  price: number;
  /** 'retracement' (0 to 1) or 'extension' (beyond the swing, in the direction of the move). */
  kind: 'retracement' | 'extension';
}

export interface Fibonacci {
  high: { i: number; t: number; price: number };
  low: { i: number; t: number; price: number };
  /** 'up' when the low came first (a rally being retraced), 'down' when the high came first. */
  direction: 'up' | 'down';
  levels: FibLevel[];
  /** The retracement level closest to the last close. */
  nearest: FibLevel;
}

/**
 * Retracement of the window's dominant swing: from its lowest low to its
 * highest high. A 38.2% retracement of a rally is 38.2% of the way back down
 * from the high; of a decline, 38.2% of the way back up from the low.
 */
export function fibonacci(bars: Bar[]): Fibonacci | null {
  if (bars.length < 2) return null;
  let hi = 0;
  let lo = 0;
  bars.forEach((b, i) => {
    if (b.h > bars[hi].h) hi = i;
    if (b.l < bars[lo].l) lo = i;
  });
  const H = bars[hi].h;
  const L = bars[lo].l;
  if (!(H > L)) return null;
  const direction = lo < hi ? 'up' : 'down';
  const span = H - L;
  const at = (r: number) => (direction === 'up' ? H - span * r : L + span * r);
  const ext = (e: number) => (direction === 'up' ? L + span * e : H - span * e);
  const levelsOut: FibLevel[] = [
    ...FIB_RATIOS.map((r) => ({ ratio: r, price: at(r), kind: 'retracement' as const })),
    ...FIB_EXTENSIONS.map((e) => ({ ratio: e, price: ext(e), kind: 'extension' as const })),
  ];
  const c = bars[bars.length - 1].c;
  const nearest = levelsOut
    .filter((l) => l.kind === 'retracement')
    .reduce((best, l) => (Math.abs(l.price - c) < Math.abs(best.price - c) ? l : best));
  return {
    high: { i: hi, t: bars[hi].t, price: H },
    low: { i: lo, t: bars[lo].t, price: L },
    direction,
    levels: levelsOut,
    nearest,
  };
}
