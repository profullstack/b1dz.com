import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '@b1dz/core';
import { analyze15mTrend, apply15mTrendFilter } from './strategies.js';

function snap(bid: number, ts: number): MarketSnapshot {
  return {
    exchange: 'kraken',
    pair: 'BTC-USD',
    bid,
    ask: bid + 0.01,
    bidSize: 1,
    askSize: 1,
    ts,
  };
}

function makeSidewaysHistory(): MarketSnapshot[] {
  return Array.from({ length: 180 }, (_, index) => {
    const wobble = Math.sin(index / 8) * 0.18;
    const drift = index * 0.001;
    return snap(100 + wobble + drift, index * 5000);
  });
}

function makeTrendingHistory(): MarketSnapshot[] {
  return Array.from({ length: 180 }, (_, index) => {
    const trend = index * 0.03;
    const wobble = Math.sin(index / 10) * 0.08;
    return snap(100 + trend + wobble, index * 5000);
  });
}

describe('15m trend filter contract', () => {
  it('classifies a tight 15m range as sideways', () => {
    const regime = analyze15mTrend(makeSidewaysHistory());
    expect(regime.regime).toBe('sideways');
    expect(regime.rangePct).toBeLessThan(1.2);
    expect(regime.driftPct).toBeLessThan(0.45);
  });

  it('suppresses weak buy signals in sideways markets', () => {
    const history = makeSidewaysHistory();
    const current = history.at(-1)!;
    const signal = { side: 'buy' as const, strength: 0.8, reason: 'weak buy' };

    expect(apply15mTrendFilter(signal, current, history)).toBeNull();
  });

  it('allows strong buy signals in sideways markets', () => {
    const history = makeSidewaysHistory();
    const current = history.at(-1)!;
    const signal = { side: 'buy' as const, strength: 0.9, reason: 'strong buy' };

    expect(apply15mTrendFilter(signal, current, history)).toEqual(signal);
  });

  it('does not suppress sell signals in sideways markets', () => {
    const history = makeSidewaysHistory();
    const current = history.at(-1)!;
    const signal = { side: 'sell' as const, strength: 0.7, reason: 'exit' };

    expect(apply15mTrendFilter(signal, current, history)).toEqual(signal);
  });

  it('does not suppress normal buys in trending markets', () => {
    const history = makeTrendingHistory();
    const current = history.at(-1)!;
    const signal = { side: 'buy' as const, strength: 0.78, reason: 'trend buy' };

    expect(apply15mTrendFilter(signal, current, history)).toEqual(signal);
  });
});
