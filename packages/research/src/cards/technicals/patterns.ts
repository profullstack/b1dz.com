/**
 * Classic chart pattern recognition from swing pivots: double tops and
 * bottoms, head and shoulders (and inverse), triangles, wedges and channels.
 *
 * Patterns are read off the alternating swing sequence. Only the most recent
 * instance of each pattern is reported, and only when it finished in the
 * later part of the window, because an old, resolved pattern says nothing
 * about the chart now.
 */
import type { Bar } from '../../lib/market.js';
import { alternating, atr, lineAt, pivots, type Bias, type Pivot } from './analysis.js';

export interface PatternLine {
  name: string;
  /** Bar indexes and prices at each end. */
  from: { i: number; price: number };
  to: { i: number; price: number };
}

export interface ChartPattern {
  pattern: string;
  bias: Bias;
  startI: number;
  endI: number;
  /** forming: not yet resolved; confirmed: price closed through the trigger line; failed: it broke the other way. */
  status: 'forming' | 'confirmed' | 'failed';
  /** The trigger: the neckline or the breakout boundary, at the last bar. */
  trigger: number;
  /** Measured-move target once triggered, when the pattern defines one. */
  target: number | null;
  lines: PatternLine[];
}

/** Pattern tolerance: half an ATR, at least 1% of the last close. */
export function patternTolerance(bars: Bar[]): number {
  const last = bars[bars.length - 1]?.c ?? 0;
  return Math.max(atr(bars) * 0.5, Math.abs(last) * 0.01);
}

function closesAfter(bars: Bar[], from: number): number[] {
  return bars.slice(from + 1).map((b) => b.c);
}

function doubles(bars: Bar[], seq: Pivot[], tol: number, recentFrom: number): ChartPattern[] {
  const out: ChartPattern[] = [];
  const n = bars.length;
  for (const top of [true, false]) {
    for (let s = seq.length - 3; s >= 0; s--) {
      const [p1, m, p2] = seq.slice(s, s + 3);
      if (p1.kind !== (top ? 'high' : 'low') || p2.i < recentFrom) continue;
      const depth = top ? Math.min(p1.price, p2.price) - m.price : m.price - Math.max(p1.price, p2.price);
      if (Math.abs(p1.price - p2.price) > tol || depth < 2.5 * tol || p2.i - p1.i < 5) continue;
      const after = closesAfter(bars, p2.i);
      const extreme = top ? Math.max(p1.price, p2.price) : Math.min(p1.price, p2.price);
      const failed = after.some((c) => (top ? c > extreme + tol : c < extreme - tol));
      const confirmed = !failed && after.some((c) => (top ? c < m.price - tol * 0.5 : c > m.price + tol * 0.5));
      out.push({
        pattern: top ? 'Double top' : 'Double bottom',
        bias: top ? 'bearish' : 'bullish',
        startI: p1.i,
        endI: p2.i,
        status: failed ? 'failed' : confirmed ? 'confirmed' : 'forming',
        trigger: m.price,
        target: top ? m.price - depth : m.price + depth,
        lines: [
          { name: top ? 'Tops' : 'Bottoms', from: { i: p1.i, price: p1.price }, to: { i: p2.i, price: p2.price } },
          { name: 'Neckline', from: { i: p1.i, price: m.price }, to: { i: n - 1, price: m.price } },
        ],
      });
      break;
    }
  }
  return out;
}

function headAndShoulders(bars: Bar[], seq: Pivot[], tol: number, recentFrom: number): ChartPattern[] {
  const out: ChartPattern[] = [];
  const n = bars.length;
  for (const normal of [true, false]) {
    for (let s = seq.length - 5; s >= 0; s--) {
      const [ls, n1, hd, n2, rs] = seq.slice(s, s + 5);
      if (ls.kind !== (normal ? 'high' : 'low') || rs.i < recentFrom) continue;
      const above = (x: number, y: number) => (normal ? x > y : x < y);
      if (!above(hd.price, ls.price + (normal ? tol : -tol)) || !above(hd.price, rs.price + (normal ? tol : -tol))) continue;
      if (Math.abs(ls.price - rs.price) > 2 * tol) continue;
      const neckHead = lineAt(n1, n2, hd.i);
      const height = Math.abs(hd.price - neckHead);
      if (height < 2 * tol) continue;
      const neckNow = lineAt(n1, n2, n - 1);
      let status: ChartPattern['status'] = 'forming';
      for (let i = rs.i + 1; i < n; i++) {
        const c = bars[i].c;
        if (normal ? c > hd.price + tol : c < hd.price - tol) {
          status = 'failed';
          break;
        }
        const neck = lineAt(n1, n2, i);
        if (normal ? c < neck - tol * 0.5 : c > neck + tol * 0.5) status = 'confirmed';
      }
      out.push({
        pattern: normal ? 'Head and shoulders' : 'Inverse head and shoulders',
        bias: normal ? 'bearish' : 'bullish',
        startI: ls.i,
        endI: rs.i,
        status,
        trigger: neckNow,
        target: normal ? neckNow - height : neckNow + height,
        lines: [
          { name: 'Neckline', from: { i: n1.i, price: n1.price }, to: { i: n - 1, price: neckNow } },
          { name: normal ? 'Head' : 'Trough', from: { i: ls.i, price: ls.price }, to: { i: hd.i, price: hd.price } },
          { name: normal ? 'Right shoulder' : 'Right low', from: { i: hd.i, price: hd.price }, to: { i: rs.i, price: rs.price } },
        ],
      });
      break;
    }
  }
  return out;
}

/** Least-squares line through pivots (x = bar index). */
function fit(points: Pivot[]): { slope: number; at: (i: number) => number } {
  const m = points.length;
  const mx = points.reduce((s, p) => s + p.i, 0) / m;
  const my = points.reduce((s, p) => s + p.price, 0) / m;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.i - mx) * (p.price - my);
    den += (p.i - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  return { slope, at: (i) => my + slope * (i - mx) };
}

function converging(bars: Bar[], seq: Pivot[], tol: number, recentFrom: number): ChartPattern[] {
  const n = bars.length;
  const tail = seq.slice(-8);
  const highs = tail.filter((p) => p.kind === 'high').slice(-4);
  const lows = tail.filter((p) => p.kind === 'low').slice(-4);
  if (highs.length < 2 || lows.length < 2 || highs.length + lows.length < 5) return [];
  const last = Math.max(highs[highs.length - 1].i, lows[lows.length - 1].i);
  if (last < recentFrom) return [];
  const start = Math.min(highs[0].i, lows[0].i);
  const up = fit(highs);
  const dn = fit(lows);
  // Every swing must sit near its own line, or this is noise, not a pattern.
  if (highs.some((p) => Math.abs(p.price - up.at(p.i)) > tol) || lows.some((p) => Math.abs(p.price - dn.at(p.i)) > tol)) return [];
  const span = n - 1 - start;
  const move = (slope: number) => slope * span;
  const flat = (slope: number) => Math.abs(move(slope)) <= tol;
  const widthStart = up.at(start) - dn.at(start);
  const widthNow = up.at(n - 1) - dn.at(n - 1);
  if (widthStart <= 0) return [];
  const narrowing = widthNow < widthStart * 0.75;
  let pattern = '';
  let bias: Bias = 'neutral';
  if (flat(up.slope) && dn.slope > 0 && narrowing) [pattern, bias] = ['Ascending triangle', 'bullish'];
  else if (up.slope < 0 && flat(dn.slope) && narrowing) [pattern, bias] = ['Descending triangle', 'bearish'];
  else if (up.slope < 0 && dn.slope > 0 && !flat(up.slope) && !flat(dn.slope) && narrowing) [pattern, bias] = ['Symmetrical triangle', 'neutral'];
  else if (up.slope > 0 && dn.slope > 0 && narrowing && !flat(dn.slope)) [pattern, bias] = ['Rising wedge', 'bearish'];
  else if (up.slope < 0 && dn.slope < 0 && narrowing && !flat(up.slope)) [pattern, bias] = ['Falling wedge', 'bullish'];
  else if (!narrowing && widthNow > 0 && Math.abs(widthNow - widthStart) <= widthStart * 0.35) {
    if (flat(up.slope) && flat(dn.slope)) [pattern, bias] = ['Horizontal range', 'neutral'];
    else if (up.slope > 0 && dn.slope > 0) [pattern, bias] = ['Rising channel', 'bullish'];
    else if (up.slope < 0 && dn.slope < 0) [pattern, bias] = ['Falling channel', 'bearish'];
  }
  if (!pattern || widthNow <= 0) return [];
  const c = bars[n - 1].c;
  const upNow = up.at(n - 1);
  const dnNow = dn.at(n - 1);
  const height = widthStart;
  let status: ChartPattern['status'] = 'forming';
  let trigger = bias === 'bearish' ? dnNow : upNow;
  let target: number | null = null;
  if (c > upNow + tol * 0.5) {
    status = bias === 'bearish' ? 'failed' : 'confirmed';
    trigger = upNow;
    target = upNow + height;
  } else if (c < dnNow - tol * 0.5) {
    status = bias === 'bullish' ? 'failed' : 'confirmed';
    trigger = dnNow;
    target = dnNow - height;
  }
  return [
    {
      pattern,
      bias,
      startI: start,
      endI: last,
      status,
      trigger,
      target,
      lines: [
        { name: 'Upper bound', from: { i: start, price: up.at(start) }, to: { i: n - 1, price: upNow } },
        { name: 'Lower bound', from: { i: start, price: dn.at(start) }, to: { i: n - 1, price: dnNow } },
      ],
    },
  ];
}

/** Every recent chart pattern, most recently completed first. */
export function chartPatterns(bars: Bar[], piv = pivots(bars)): ChartPattern[] {
  if (bars.length < 20) return [];
  const seq = alternating(piv);
  const tol = patternTolerance(bars);
  const recentFrom = Math.floor(bars.length * 0.5);
  return [
    ...headAndShoulders(bars, seq, tol, recentFrom),
    ...doubles(bars, seq, tol, recentFrom),
    ...converging(bars, seq, tol, recentFrom),
  ].sort((a, b) => b.endI - a.endI);
}
