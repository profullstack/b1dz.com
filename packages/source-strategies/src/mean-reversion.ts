/**
 * Mean Reversion — fade extremes back toward the average.
 *
 * Long when RSI is oversold, short when overbought. Asset-agnostic; the engine
 * decides whether a venue/session permits acting on the signal.
 */
import type { StrategyPlugin, Signal, MarketSnapshot } from '@b1dz/core';
import { rsi } from '@b1dz/core';
import { midSeries, clamp01 } from './helpers.js';

const PERIOD = 14;
const OVERSOLD = 30;
const OVERBOUGHT = 70;
const MIN_POINTS = PERIOD + 1;

export const meanReversion: StrategyPlugin = {
  manifest: {
    id: 'mean-reversion',
    kind: 'strategy',
    version: '0.1.0',
    name: 'Mean Reversion (RSI)',
    author: 'b1dz',
    description:
      'Fades extremes: buys when RSI is oversold (<30), sells when overbought (>70). Works on crypto and equities (asset-agnostic).',
    capabilities: ['style:mean-reversion', 'indicator:rsi', 'asset:crypto', 'asset:equity', 'timeframe:any'],
  },
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null {
    const series = midSeries(snap, history);
    if (series.length < MIN_POINTS) return null;

    const r = rsi(series, PERIOD);
    if (r <= OVERSOLD) {
      // The deeper below the threshold, the stronger the signal.
      return { side: 'buy', strength: clamp01((OVERSOLD - r) / OVERSOLD), reason: `RSI ${r.toFixed(1)} oversold` };
    }
    if (r >= OVERBOUGHT) {
      return { side: 'sell', strength: clamp01((r - OVERBOUGHT) / (100 - OVERBOUGHT)), reason: `RSI ${r.toFixed(1)} overbought` };
    }
    return null;
  },
};
