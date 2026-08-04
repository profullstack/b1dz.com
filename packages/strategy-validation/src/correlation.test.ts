import { describe, it, expect } from 'vitest';
import type { StrategyPlugin, MarketSnapshot } from '@b1dz/core';
import { snapshotsFrom, syntheticTrades } from './synthetic.js';
import {
  pearson,
  signalVector,
  signalCorrelation,
  returnCorrelation,
  findDuplicates,
} from './correlation.js';

describe('pearson', () => {
  it('is 1 for perfect positive correlation', () => {
    expect(pearson([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(pearson([5, 10], [10, 20])).toBeCloseTo(1, 10);
  });

  it('is -1 for perfect negative correlation', () => {
    expect(pearson([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(pearson([1, 0, -1], [-1, 2, -1])).toBeCloseTo(0, 12);
  });

  it('returns 0 for degenerate cases', () => {
    expect(pearson([], [1, 2])).toBe(0);
    expect(pearson([1, 2], [])).toBe(0);
    expect(pearson([3, 3, 3], [3, 3, 3])).toBe(0);
    expect(pearson([1], [1])).toBe(0);
  });

  it('returns 0 when any observation is non-finite', () => {
    expect(pearson([1, NaN, 3], [1, 2, 3])).toBe(0);
    expect(pearson([1, 2, 3], [1, Infinity, 3])).toBe(0);
  });
});

describe('signalVector', () => {
  const makePlugin = (signals: (number | null)[]): StrategyPlugin => ({
    manifest: { id: 's', kind: 'strategy', version: '0', name: 'S', capabilities: [] },
    evaluate(_snap, history) {
      const s = signals[history.length];
      if (s === null || s === undefined) return null;
      return s > 0
        ? { side: 'buy' as const, strength: 1, reason: 'b' }
        : { side: 'sell' as const, strength: 1, reason: 's' };
    },
  });

  it('encodes buy as +1, sell as -1, no signal as 0', () => {
    const snaps = snapshotsFrom([100, 100, 100, 100]);
    const vec = signalVector(makePlugin([null, 1, -1, null]), snaps);
    expect(vec).toEqual([0, 1, -1, 0]);
  });

  it('treats a throwing evaluate as no-signal', () => {
    const boom: StrategyPlugin = {
      manifest: { id: 'b', kind: 'strategy', version: '0', name: 'B', capabilities: [] },
      evaluate() {
        throw new Error('boom');
      },
    };
    const snaps = snapshotsFrom([100]);
    expect(signalVector(boom, snaps)).toEqual([0]);
  });

  it('returns all zeros when the plugin always returns null', () => {
    const silent: StrategyPlugin = {
      manifest: { id: 'z', kind: 'strategy', version: '0', name: 'Z', capabilities: [] },
      evaluate() {
        return null;
      },
    };
    const snaps = snapshotsFrom([100, 101, 102]);
    expect(signalVector(silent, snaps)).toEqual([0, 0, 0]);
  });
});

describe('signalCorrelation', () => {
  const snap = (price: number, ts: number): MarketSnapshot => ({
    exchange: 'test',
    pair: 'X',
    bid: price,
    ask: price,
    bidSize: 1,
    askSize: 1,
    ts,
    assetClass: undefined,
  });

  it('is 1 for identical strategies', () => {
    const snaps: MarketSnapshot[] = [snap(100, 0), snap(101, 1), snap(102, 2)];
    const makeBuyer = (): StrategyPlugin => ({
      manifest: { id: 'a', kind: 'strategy', version: '0', name: 'A', capabilities: [] },
      evaluate(_s, h) {
        return h.length < 2 ? { side: 'buy' as const, strength: 1, reason: '' } : null;
      },
    });
    expect(signalCorrelation(makeBuyer(), makeBuyer(), snaps)).toBeCloseTo(1, 10);
  });

  it('is -1 for opposite strategies', () => {
    // Need varying signals so variance is non-zero (pearson returns 0 for constant vectors).
    const snaps: MarketSnapshot[] = [snap(100, 0), snap(101, 1), snap(102, 2), snap(103, 3)];
    const pA: StrategyPlugin = {
      manifest: { id: 'a', kind: 'strategy', version: '0', name: 'A', capabilities: [] },
      evaluate(_s, h) {
        return h.length % 2 === 0
          ? { side: 'buy' as const, strength: 1, reason: '' }
          : null;
      },
    };
    const pB: StrategyPlugin = {
      manifest: { id: 'b', kind: 'strategy', version: '0', name: 'B', capabilities: [] },
      evaluate(_s, h) {
        return h.length % 2 === 0
          ? { side: 'sell' as const, strength: 1, reason: '' }
          : null;
      },
    };
    // pA: [1,0,1,0], pB: [-1,0,-1,0] → correlation = -1
    expect(signalCorrelation(pA, pB, snaps)).toBeCloseTo(-1, 10);
  });

  it('returns 0 when both are permanently silent', () => {
    const snaps: MarketSnapshot[] = [snap(100, 0)];
    const silent: StrategyPlugin = {
      manifest: { id: 's', kind: 'strategy', version: '0', name: 'S', capabilities: [] },
      evaluate() {
        return null;
      },
    };
    // All zeros → zero variance → pearson returns 0
    expect(signalCorrelation(silent, silent, snaps)).toBe(0);
  });
});

describe('returnCorrelation', () => {
  it('is 1 for identical P&L streams', () => {
    const trades = syntheticTrades([0.1, -0.05, 0.2], {
      startTs: 0,
      stepMs: 7 * 24 * 3600 * 1000,
    });
    expect(returnCorrelation(trades, trades, 0, Date.now())).toBeCloseTo(1, 10);
  });

  it('returns 0 when one side has no trades', () => {
    const trades = syntheticTrades([0.1], { startTs: 0 });
    expect(returnCorrelation(trades, [], 0, Date.now())).toBe(0);
  });
});

describe('findDuplicates', () => {
  const snap = (price: number, ts: number): MarketSnapshot => ({
    exchange: 'test',
    pair: 'X',
    bid: price,
    ask: price,
    bidSize: 1,
    askSize: 1,
    ts,
    assetClass: undefined,
  });

  it('returns empty when catalog is empty', () => {
    const snaps: MarketSnapshot[] = [snap(100, 0)];
    const plugin: StrategyPlugin = {
      manifest: { id: 'x', kind: 'strategy', version: '0', name: 'X', capabilities: [] },
      evaluate() {
        return null;
      },
    };
    expect(findDuplicates(plugin, [], [], snaps)).toEqual([]);
  });

  it('returns empty when snapshots are empty', () => {
    const plugin: StrategyPlugin = {
      manifest: { id: 'x', kind: 'strategy', version: '0', name: 'X', capabilities: [] },
      evaluate() {
        return null;
      },
    };
    expect(findDuplicates(plugin, [], [], [])).toEqual([]);
  });

  it('finds a catalog entry with high signal + return correlation', () => {
    const WEEK_MS = 7 * 24 * 3600 * 1000;
    // 5 snapshots spanning 4 weeks so we get ≥2 buckets with both trades in range.
    const snaps: MarketSnapshot[] = [
      snap(100, 0),
      snap(101, WEEK_MS),
      snap(102, 2 * WEEK_MS),
      snap(103, 3 * WEEK_MS),
      snap(104, 4 * WEEK_MS),
    ];
    const makeAlternating = (): StrategyPlugin => ({
      manifest: { id: 'dup', kind: 'strategy', version: '0', name: 'Dup', capabilities: [] },
      evaluate(_s, h) {
        return h.length % 2 === 0
          ? { side: 'buy' as const, strength: 1, reason: '' }
          : null;
      },
    });
    const plugin = makeAlternating();
    const trades = syntheticTrades([0.01, 0.02], {
      startTs: 0,
      stepMs: WEEK_MS,
    });
    const catalog = [{ plugin: makeAlternating(), trades, id: 'existing' }];
    const result = findDuplicates(plugin, trades, catalog, snaps, 0.8);
    expect(result.length).toBeGreaterThanOrEqual(1);
    if (result.length > 0) {
      expect(result[0]!.strategyId).toBe('existing');
      expect(result[0]!.signal).toBeCloseTo(1, 10);
    }
  });
});
