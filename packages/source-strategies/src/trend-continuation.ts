/**
 * Trend Continuation — ride an established trend.
 *
 * Long when the fast EMA is above the slow EMA and MACD momentum is rising;
 * short the mirror image. Asset-agnostic: runs on crypto ticks or equity bars
 * unchanged. Signals-only — the engine applies session gating, sizing, and risk.
 */
import type { StrategyPlugin, Signal, MarketSnapshot } from '@b1dz/core';
import { ema, macd } from '@b1dz/core';
import { midSeries, clamp01 } from './helpers.js';

const FAST = 12;
const SLOW = 26;
/** Need enough points for the slow EMA + MACD signal to be meaningful. */
const MIN_POINTS = SLOW + 9;

export const trendContinuation: StrategyPlugin = {
  manifest: {
    id: 'trend-continuation',
    kind: 'strategy',
    version: '0.1.0',
    name: 'Trend Continuation',
    author: 'b1dz',
    description:
      'Follows an established trend: long when the fast EMA leads the slow EMA with rising MACD momentum, short on the inverse. Works on crypto and equities (asset-agnostic).',
    capabilities: ['style:trend', 'style:momentum', 'asset:crypto', 'asset:equity', 'timeframe:any'],
  },
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null {
    const series = midSeries(snap, history);
    if (series.length < MIN_POINTS) return null;

    const fast = ema(series, FAST).at(-1)!;
    const slow = ema(series, SLOW).at(-1)!;
    const m = macd(series);
    const rising = m.histogram > m.prevHistogram;
    const falling = m.histogram < m.prevHistogram;

    // Gate on trend + momentum direction (fast/slow cross with same-sign MACD).
    // Momentum *slope* (rising/falling) only boosts strength — requiring it to
    // gate would miss steady trends where MACD has reached equilibrium.
    const spread = Math.abs(fast - slow) / (slow || 1);

    if (fast > slow && m.histogram > 0) {
      const strength = clamp01(spread * 50 * (rising ? 1 : 0.6));
      return { side: 'buy', strength, reason: `fast EMA > slow EMA, MACD ${rising ? 'rising' : 'positive'}` };
    }
    if (fast < slow && m.histogram < 0) {
      const strength = clamp01(spread * 50 * (falling ? 1 : 0.6));
      return { side: 'sell', strength, reason: `fast EMA < slow EMA, MACD ${falling ? 'falling' : 'negative'}` };
    }
    return null;
  },
};
