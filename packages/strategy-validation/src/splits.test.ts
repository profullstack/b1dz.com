import { describe, it, expect } from 'vitest';
import type { MarketSnapshot } from '@b1dz/core';
import {
  DEFAULT_OOS_RATIO,
  MIN_WARMUP_BARS,
  anchoredWalkForward,
  isChronological,
  trainTestSplit,
  walkForwardSplits,
  type WalkForwardSplit,
} from './splits.js';
import { snapshotsFrom } from './synthetic.js';

/** `bars` snapshots whose price equals their index, so identity is checkable. */
const bars = (n: number): MarketSnapshot[] =>
  snapshotsFrom(Array.from({ length: n }, (_, i) => i + 1));

const firstTs = (s: MarketSnapshot[]) => s[0]!.ts;
const lastTs = (s: MarketSnapshot[]) => s[s.length - 1]!.ts;

/** Every invariant a walk-forward set must satisfy to be worth reporting. */
function assertWalkForwardInvariants(splits: WalkForwardSplit[], minBars: number): void {
  splits.forEach((s, i) => {
    expect(s.index).toBe(i);
    expect(s.train.length).toBeGreaterThanOrEqual(minBars);
    expect(s.test.length).toBeGreaterThanOrEqual(minBars);
    // No leakage: every test bar is strictly after every train bar.
    expect(firstTs(s.test)).toBeGreaterThan(lastTs(s.train));
    expect(isChronological(s.train)).toBe(true);
    expect(isChronological(s.test)).toBe(true);
    if (i > 0) {
      const prev = splits[i - 1]!;
      // Test windows are non-overlapping and strictly forward-ordered.
      expect(firstTs(s.test)).toBeGreaterThan(lastTs(prev.test));
    }
  });
}

describe('isChronological', () => {
  it('accepts a forward-ordered series', () => {
    expect(isChronological(bars(50))).toBe(true);
    expect(isChronological([])).toBe(true);
    expect(isChronological(bars(1))).toBe(true);
  });

  it('accepts duplicate timestamps (noise, not leakage)', () => {
    const s = bars(3);
    s[1]!.ts = s[0]!.ts;
    expect(isChronological(s)).toBe(true);
  });

  it('rejects a series with any backwards step', () => {
    const s = bars(10);
    s[7]!.ts = s[2]!.ts - 1;
    expect(isChronological(s)).toBe(false);
  });

  it('rejects a shuffled series', () => {
    const s = bars(40);
    const shuffled = [s[10]!, s[3]!, s[39]!, ...s.slice(0, 3)];
    expect(isChronological(shuffled)).toBe(false);
  });
});

describe('trainTestSplit', () => {
  it('cuts chronologically at 1 - oosRatio and keeps every bar', () => {
    const s = bars(300);
    const { inSample, outOfSample } = trainTestSplit(s, 0.3);
    expect(inSample).toHaveLength(210);
    expect(outOfSample).toHaveLength(90);
    expect(inSample[0]!.ts).toBe(s[0]!.ts);
    expect(outOfSample[0]!.ts).toBe(s[210]!.ts);
    expect(lastTs(outOfSample)).toBe(lastTs(s));
    // Contiguous, no gap, no overlap, nothing dropped.
    expect(inSample.length + outOfSample.length).toBe(s.length);
    expect(firstTs(outOfSample)).toBeGreaterThan(lastTs(inSample));
  });

  it('never shuffles: both halves stay in original order', () => {
    const s = bars(200);
    const { inSample, outOfSample } = trainTestSplit(s, 0.25);
    expect(isChronological(inSample)).toBe(true);
    expect(isChronological(outOfSample)).toBe(true);
    expect([...inSample, ...outOfSample].map((x) => x.ts)).toEqual(s.map((x) => x.ts));
  });

  it('defaults to a 30% holdout', () => {
    expect(DEFAULT_OOS_RATIO).toBe(0.3);
    expect(trainTestSplit(bars(300)).outOfSample).toHaveLength(90);
  });

  it('widens the holdout when the requested ratio is shorter than the warmup', () => {
    // minBars outranks oosRatio: a 30-bar holdout on 100 bars would be shorter
    // than a MACD warmup, so the cut moves inward to 65/35.
    const { inSample, outOfSample } = trainTestSplit(bars(100), 0.3);
    expect(inSample).toHaveLength(65);
    expect(outOfSample).toHaveLength(MIN_WARMUP_BARS);
  });

  it('does not mutate or alias the input array', () => {
    const s = bars(100);
    const { inSample } = trainTestSplit(s, 0.3);
    inSample.push(s[0]!);
    expect(s).toHaveLength(100);
  });

  it('returns an EMPTY out-of-sample block rather than a fake short one', () => {
    // 60 bars cannot give both sides the 35-bar warmup, so there is no honest
    // holdout. An empty block fails the OOS gates downstream, which is correct:
    // "we do not know" must never be rendered as "it passed".
    const { inSample, outOfSample } = trainTestSplit(bars(60), 0.3);
    expect(inSample).toHaveLength(60);
    expect(outOfSample).toEqual([]);
  });

  it('handles an empty series', () => {
    expect(trainTestSplit([], 0.3)).toEqual({ inSample: [], outOfSample: [] });
  });

  it('keeps both sides at or above minBars even for an extreme ratio', () => {
    for (const ratio of [0, 0.01, 0.5, 0.99, 1, 5, Number.NaN, -1]) {
      const { inSample, outOfSample } = trainTestSplit(bars(100), ratio);
      expect(inSample.length).toBeGreaterThanOrEqual(MIN_WARMUP_BARS);
      expect(outOfSample.length).toBeGreaterThanOrEqual(MIN_WARMUP_BARS);
      expect(inSample.length + outOfSample.length).toBe(100);
    }
  });

  it('honours a custom minBars', () => {
    const { inSample, outOfSample } = trainTestSplit(bars(30), 0.3, { minBars: 10 });
    expect(inSample).toHaveLength(20);
    expect(outOfSample).toHaveLength(10);
    expect(trainTestSplit(bars(19), 0.3, { minBars: 10 }).outOfSample).toEqual([]);
    // With room to spare the requested ratio is respected exactly.
    expect(trainTestSplit(bars(100), 0.3, { minBars: 10 }).outOfSample).toHaveLength(30);
  });
});

describe('walkForwardSplits', () => {
  it('produces the documented rolling geometry', () => {
    // n=300, trainRatio 0.6 → trainSize 180; remaining 120 / 3 folds → testSize 40.
    const s = bars(300);
    const splits = walkForwardSplits(s, { folds: 3, trainRatio: 0.6 });
    expect(splits).toHaveLength(3);
    expect(splits.map((f) => f.train.length)).toEqual([180, 180, 180]);
    expect(splits.map((f) => f.test.length)).toEqual([40, 40, 40]);
    expect(splits[0]!.test[0]!.ts).toBe(s[180]!.ts);
    expect(splits[1]!.test[0]!.ts).toBe(s[220]!.ts);
    expect(splits[2]!.test[0]!.ts).toBe(s[260]!.ts);
    expect(lastTs(splits[2]!.test)).toBe(lastTs(s));
    assertWalkForwardInvariants(splits, MIN_WARMUP_BARS);
  });

  it('rolls the train window forward rather than expanding it', () => {
    const splits = walkForwardSplits(bars(300), { folds: 3, trainRatio: 0.6 });
    const starts = splits.map((f) => firstTs(f.train));
    expect(new Set(starts).size).toBe(3); // each fold starts later
    expect(starts[1]!).toBeGreaterThan(starts[0]!);
    expect(starts[2]!).toBeGreaterThan(starts[1]!);
  });

  it('never leaks: no test bar precedes its own train window', () => {
    for (const n of [200, 300, 500, 1000]) {
      for (const folds of [1, 2, 3, 5, 8]) {
        assertWalkForwardInvariants(walkForwardSplits(bars(n), { folds }), MIN_WARMUP_BARS);
      }
    }
  });

  it('returns FEWER folds instead of windows shorter than minBars', () => {
    // n=200, trainRatio 0.6 → trainSize 120, remaining 80.
    // 5 folds → 16 bars each (too short); 4 → 20; 3 → 26; 2 → 40 ✓.
    const splits = walkForwardSplits(bars(200), { folds: 5, trainRatio: 0.6 });
    expect(splits).toHaveLength(2);
    expect(splits.map((f) => f.test.length)).toEqual([40, 40]);
    assertWalkForwardInvariants(splits, MIN_WARMUP_BARS);
  });

  it('returns no folds at all when the series cannot support one honest window', () => {
    expect(walkForwardSplits(bars(50), { folds: 4 })).toEqual([]);
    expect(walkForwardSplits(bars(80), { folds: 4, trainRatio: 0.6 })).toEqual([]);
    expect(walkForwardSplits([], { folds: 4 })).toEqual([]);
    expect(walkForwardSplits(bars(1), { folds: 1 })).toEqual([]);
  });

  it('honours a relaxed minBars', () => {
    const splits = walkForwardSplits(bars(100), { folds: 4, trainRatio: 0.6, minBars: 10 });
    expect(splits).toHaveLength(4);
    expect(splits.map((f) => f.test.length)).toEqual([10, 10, 10, 10]);
    assertWalkForwardInvariants(splits, 10);
  });

  it('clamps nonsense fold counts and train ratios instead of throwing', () => {
    expect(walkForwardSplits(bars(300), { folds: 0 })).toHaveLength(1);
    expect(walkForwardSplits(bars(300), { folds: -3 })).toHaveLength(1);
    expect(walkForwardSplits(bars(300), { folds: 2.7, trainRatio: 0.6 })).toHaveLength(2);
    for (const trainRatio of [0, 1, 5, -2, Number.NaN]) {
      const splits = walkForwardSplits(bars(400), { folds: 2, trainRatio });
      assertWalkForwardInvariants(splits, MIN_WARMUP_BARS);
    }
  });
});

describe('anchoredWalkForward', () => {
  it('expands the train window from bar 0', () => {
    // n=400, trainRatio 0.5 → initialTrain 200; remaining 200 / 4 → testSize 50.
    const s = bars(400);
    const splits = anchoredWalkForward(s, { folds: 4 });
    expect(splits).toHaveLength(4);
    expect(splits.map((f) => f.train.length)).toEqual([200, 250, 300, 350]);
    expect(splits.map((f) => f.test.length)).toEqual([50, 50, 50, 50]);
    for (const f of splits) expect(firstTs(f.train)).toBe(s[0]!.ts);
    expect(lastTs(splits[3]!.test)).toBe(lastTs(s));
    assertWalkForwardInvariants(splits, MIN_WARMUP_BARS);
  });

  it('uses more data than the rolling variant for the same fold count', () => {
    const anchored = anchoredWalkForward(bars(400), { folds: 4, trainRatio: 0.5 });
    const rolling = walkForwardSplits(bars(400), { folds: 4, trainRatio: 0.5 });
    const trainBars = (fs: WalkForwardSplit[]) => fs.reduce((n, f) => n + f.train.length, 0);
    expect(trainBars(anchored)).toBeGreaterThan(trainBars(rolling));
  });

  it('never leaks across a range of shapes', () => {
    for (const n of [150, 300, 700]) {
      for (const folds of [1, 2, 4, 6]) {
        assertWalkForwardInvariants(anchoredWalkForward(bars(n), { folds }), MIN_WARMUP_BARS);
      }
    }
  });

  it('returns fewer folds rather than short ones', () => {
    // n=150, trainRatio 0.5 → initialTrain 75, remaining 75.
    // 4 folds → 18 bars (short); 3 → 25 (short); 2 → 37 ✓.
    const splits = anchoredWalkForward(bars(150), { folds: 4 });
    expect(splits).toHaveLength(2);
    expect(splits.map((f) => f.test.length)).toEqual([37, 37]);
  });

  it('returns nothing when the series is too short', () => {
    expect(anchoredWalkForward(bars(60), { folds: 3 })).toEqual([]);
    expect(anchoredWalkForward([], { folds: 3 })).toEqual([]);
  });
});
