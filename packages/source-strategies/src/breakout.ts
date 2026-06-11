/**
 * Breakout / Breakdown — trade range expansion.
 *
 * Long when price pushes above the highest mid of the lookback window, short
 * when it breaks below the lowest. The current bar is excluded from the
 * reference window so the break is measured against prior range, not itself.
 * Asset-agnostic.
 */
import type { StrategyPlugin, Signal, MarketSnapshot } from '@b1dz/core';
import { midSeries, clamp01 } from './helpers.js';

const LOOKBACK = 20;
const MIN_POINTS = LOOKBACK + 1;

export const breakout: StrategyPlugin = {
  manifest: {
    id: 'breakout',
    kind: 'strategy',
    version: '0.1.0',
    name: 'Breakout / Breakdown',
    author: 'b1dz',
    description:
      'Trades range expansion: buys a push above the prior N-bar high, sells a break below the prior N-bar low. Works on crypto and equities (asset-agnostic).',
    capabilities: ['style:breakout', 'asset:crypto', 'asset:equity', 'timeframe:any'],
  },
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null {
    const series = midSeries(snap, history);
    if (series.length < MIN_POINTS) return null;

    const current = series.at(-1)!;
    const window = series.slice(-(LOOKBACK + 1), -1); // prior LOOKBACK bars, excluding current
    const hi = Math.max(...window);
    const lo = Math.min(...window);

    if (current > hi) {
      return { side: 'buy', strength: clamp01((current - hi) / (hi || 1) * 100), reason: `broke ${LOOKBACK}-bar high ${hi.toFixed(4)}` };
    }
    if (current < lo) {
      return { side: 'sell', strength: clamp01((lo - current) / (lo || 1) * 100), reason: `broke ${LOOKBACK}-bar low ${lo.toFixed(4)}` };
    }
    return null;
  },
};
