/**
 * Candlestick pattern recognition on daily bars.
 *
 * Shapes are judged against the bar's own range and the local ATR, and the
 * reversal patterns need the trend they reverse: a hammer only counts after a
 * decline, the same shape after a rally is a hanging man. The trend is the
 * close five bars back versus the close one bar back, measured in ATRs.
 */
import type { Bar } from '../../lib/market.js';
import { atrSeries, type Bias } from './analysis.js';

export interface CandleHit {
  i: number;
  t: number;
  pattern: string;
  bias: Bias;
  /** Bars the pattern spans (1 to 3), ending at i. */
  bars: number;
}

const body = (b: Bar) => Math.abs(b.c - b.o);
const range = (b: Bar) => b.h - b.l;
const upper = (b: Bar) => b.h - Math.max(b.o, b.c);
const lower = (b: Bar) => Math.min(b.o, b.c) - b.l;
const bull = (b: Bar) => b.c > b.o;
const bear = (b: Bar) => b.c < b.o;
const mid = (b: Bar) => (b.o + b.c) / 2;

/** 'down', 'up' or 'flat' going into bar i (excluding it). */
export function trendInto(bars: Bar[], i: number, atr: number): 'down' | 'up' | 'flat' {
  if (i < 6 || atr <= 0) return 'flat';
  const move = bars[i - 1].c - bars[i - 6].c;
  if (move <= -atr) return 'down';
  if (move >= atr) return 'up';
  return 'flat';
}

/** Patterns completed at bar i (several can complete on one bar). */
export function candlesAt(bars: Bar[], i: number, atrs: number[] = atrSeries(bars)): CandleHit[] {
  const out: CandleHit[] = [];
  const b = bars[i];
  const r = range(b);
  const a = atrs[i] || r;
  if (!(r > 0)) return out;
  const trend = trendInto(bars, i, a);
  const hit = (pattern: string, bias: Bias, span = 1) => out.push({ i, t: b.t, pattern, bias, bars: span });

  // ---- three-bar patterns
  if (i >= 2) {
    const p2 = bars[i - 2];
    const p1 = bars[i - 1];
    const t3 = trendInto(bars, i - 2, atrs[i - 2] || a);
    if (bear(p2) && body(p2) >= 0.6 * a && body(p1) <= 0.3 * body(p2) && bull(b) && b.c > mid(p2) && t3 === 'down') hit('Morning star', 'bullish', 3);
    if (bull(p2) && body(p2) >= 0.6 * a && body(p1) <= 0.3 * body(p2) && bear(b) && b.c < mid(p2) && t3 === 'up') hit('Evening star', 'bearish', 3);
    const soldiers = [p2, p1, b].every((x) => bull(x) && body(x) >= 0.5 * range(x) && body(x) >= 0.4 * a);
    if (soldiers && p1.c > p2.c && b.c > p1.c && p1.o >= p2.o && p1.o <= p2.c && b.o >= p1.o && b.o <= p1.c) hit('Three white soldiers', 'bullish', 3);
    const crows = [p2, p1, b].every((x) => bear(x) && body(x) >= 0.5 * range(x) && body(x) >= 0.4 * a);
    if (crows && p1.c < p2.c && b.c < p1.c && p1.o <= p2.o && p1.o >= p2.c && b.o <= p1.o && b.o >= p1.c) hit('Three black crows', 'bearish', 3);
  }

  // ---- two-bar patterns
  if (i >= 1) {
    const p = bars[i - 1];
    if (bear(p) && bull(b) && b.o <= p.c && b.c >= p.o && body(b) > body(p) && trend !== 'up') hit('Bullish engulfing', 'bullish', 2);
    if (bull(p) && bear(b) && b.o >= p.c && b.c <= p.o && body(b) > body(p) && trend !== 'down') hit('Bearish engulfing', 'bearish', 2);
    const insideBody = Math.max(b.o, b.c) <= Math.max(p.o, p.c) && Math.min(b.o, b.c) >= Math.min(p.o, p.c) && body(b) <= 0.5 * body(p);
    if (insideBody && body(p) >= 0.6 * a && bear(p) && bull(b) && trend === 'down') hit('Bullish harami', 'bullish', 2);
    if (insideBody && body(p) >= 0.6 * a && bull(p) && bear(b) && trend === 'up') hit('Bearish harami', 'bearish', 2);
    if (bear(p) && body(p) >= 0.6 * a && bull(b) && b.o < p.c && b.c > mid(p) && b.c < p.o && trend === 'down') hit('Piercing line', 'bullish', 2);
    if (bull(p) && body(p) >= 0.6 * a && bear(b) && b.o > p.c && b.c < mid(p) && b.c > p.o && trend === 'up') hit('Dark cloud cover', 'bearish', 2);
  }

  // ---- one-bar patterns
  const bd = body(b);
  if (bd <= 0.1 * r && r >= 0.3 * a) hit('Doji', 'neutral');
  else if (lower(b) >= 2 * bd && upper(b) <= Math.max(0.5 * bd, 0.1 * r) && bd >= 0.05 * r) {
    if (trend === 'down') hit('Hammer', 'bullish');
    else if (trend === 'up') hit('Hanging man', 'bearish');
  } else if (upper(b) >= 2 * bd && lower(b) <= Math.max(0.5 * bd, 0.1 * r) && bd >= 0.05 * r) {
    if (trend === 'down') hit('Inverted hammer', 'bullish');
    else if (trend === 'up') hit('Shooting star', 'bearish');
  } else if (bd >= 0.9 * r && r >= a) hit(bull(b) ? 'Bullish marubozu' : 'Bearish marubozu', bull(b) ? 'bullish' : 'bearish');

  return out;
}

/** Every pattern in the last `lookback` bars, newest first. */
export function candlestickPatterns(bars: Bar[], lookback = 30): CandleHit[] {
  const atrs = atrSeries(bars);
  const out: CandleHit[] = [];
  for (let i = bars.length - 1; i >= Math.max(1, bars.length - lookback); i--) out.push(...candlesAt(bars, i, atrs));
  return out;
}
