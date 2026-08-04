/**
 * Chronological sample splitting — in-sample / out-of-sample and walk-forward.
 *
 * WHY THIS EXISTS
 *
 * A backtest run over the same bars that were used to choose the strategy's
 * parameters is not evidence. It is a restatement of the search. The only
 * measurement with any information content is one taken on bars the selection
 * process never saw, which means the data has to be cut before it is used, and
 * the cut has to be respected.
 *
 * THE FAILURE MODE
 *
 * Every generic ML splitter shuffles. `train_test_split(X, y)` from scikit-learn
 * shuffles by default. Shuffling a price series is not a mild methodological
 * lapse, it is total leakage: with interleaved train and test bars the model gets
 * to see tomorrow's price while predicting today's, and the resulting accuracy is
 * unbounded and completely fake. Nothing in this file shuffles, nothing sorts,
 * and nothing samples. Windows are contiguous, forward-ordered, and cut by index.
 *
 * The second failure mode is subtler and more common: windows too short to be
 * meaningful. A MACD-histogram strategy emits nothing at all for its first 35
 * bars (slow period 26 + signal period 9, see osd/compile.ts `indicatorMinPoints`),
 * so a 20-bar test fold measures a strategy that is definitionally silent and
 * reports "0 trades, 0% return" as if that were a finding. `minBars` therefore
 * defaults to exactly that warmup, and when the data cannot support the requested
 * number of folds we return FEWER folds rather than short ones. Three honest
 * windows beat ten fictional ones.
 *
 * ROLLING VS ANCHORED
 *
 * `walkForwardSplits()` rolls a fixed-size train window forward. It asks "does
 * this strategy work on recent history", which is the right question for a
 * regime-sensitive strategy and the harsher test.
 *
 * `anchoredWalkForward()` expands the train window from bar 0. It asks "does this
 * strategy work given everything known so far", which is what a live deployment
 * actually experiences, and it uses the data more efficiently on short series.
 *
 * Run both when you can afford it; they fail differently, and a strategy that
 * passes rolling but not anchored has almost certainly been fitted to the most
 * recent regime.
 */
import type { MarketSnapshot } from '@b1dz/core';

/**
 * Minimum usable window length, in bars.
 *
 * 35 = MACD's warmup (slow 26 + signal 9), the slowest indicator the TSP
 * compiler supports. Below this the slowest strategy in the catalog cannot emit
 * a single signal, so any window shorter than this measures the warmup, not the
 * strategy.
 */
export const MIN_WARMUP_BARS = 35;

/** Default fraction of the series held back for out-of-sample testing. */
export const DEFAULT_OOS_RATIO = 0.3;

export interface TrainTestSplit {
  inSample: MarketSnapshot[];
  outOfSample: MarketSnapshot[];
}

export interface WalkForwardSplit {
  /** 0-based fold number, in forward chronological order. */
  index: number;
  train: MarketSnapshot[];
  test: MarketSnapshot[];
}

export interface SplitOptions {
  /** Refuse to emit any window shorter than this. Default `MIN_WARMUP_BARS`. */
  minBars?: number;
}

export interface WalkForwardOptions extends SplitOptions {
  /** Requested number of folds. Fewer are returned if the data cannot support them. */
  folds?: number;
  /** Fraction of the series in each train window (rolling) or the first one (anchored). */
  trainRatio?: number;
}

/**
 * True when timestamps are non-decreasing.
 *
 * Worth checking explicitly rather than assuming: snapshots arriving from a
 * database without an ORDER BY, or merged from two feeds, come back in arbitrary
 * order, and every function in this package silently produces garbage on an
 * unordered series — `replayStrategy()` would compute indicators over shuffled
 * prices and a split would put future bars in the train window. It is a cheap
 * O(n) check for a class of bug that is otherwise invisible in the output.
 *
 * Equal timestamps are allowed (duplicate ticks are noise, not leakage);
 * decreasing ones are not.
 */
export function isChronological(snapshots: MarketSnapshot[]): boolean {
  for (let i = 1; i < snapshots.length; i++) {
    if (snapshots[i]!.ts < snapshots[i - 1]!.ts) return false;
  }
  return true;
}

/**
 * Split a series into a leading in-sample block and a trailing out-of-sample
 * block. Chronological, contiguous, never shuffled.
 *
 * `minBars` outranks `oosRatio`, in both directions:
 *
 *   - If the requested ratio would leave either side shorter than `minBars`, the
 *     cut is moved inward until both sides clear it. A 100-bar series with a 30%
 *     holdout therefore splits 65/35, not 70/30 — a 30-bar holdout is shorter
 *     than a MACD warmup and would measure silence.
 *   - If the series cannot give BOTH sides `minBars` at any cut, the whole series
 *     is returned as in-sample and the out-of-sample block is EMPTY. That is
 *     deliberate and it is not a silent success: an empty out-of-sample block
 *     produces zero out-of-sample trades, which fails the gauntlet's
 *     out-of-sample gates. Faking a 12-bar holdout to make the shape of the
 *     report look right would convert "we don't know" into "it passed", which is
 *     the one transformation this package must never perform.
 */
export function trainTestSplit(
  snapshots: MarketSnapshot[],
  oosRatio: number = DEFAULT_OOS_RATIO,
  opts: SplitOptions = {},
): TrainTestSplit {
  const minBars = opts.minBars ?? MIN_WARMUP_BARS;
  const n = snapshots.length;

  // Clamp to a ratio that can actually leave data on both sides.
  const ratio = Number.isFinite(oosRatio) ? Math.min(Math.max(oosRatio, 0), 0.9) : DEFAULT_OOS_RATIO;

  if (n < minBars * 2) return { inSample: snapshots.slice(), outOfSample: [] };

  let cut = Math.floor(n * (1 - ratio));
  // Both sides must clear minBars; nudge the cut inward if rounding put it out.
  cut = Math.min(Math.max(cut, minBars), n - minBars);

  return { inSample: snapshots.slice(0, cut), outOfSample: snapshots.slice(cut) };
}

/**
 * Largest fold count ≤ `folds` for which every train and test window clears
 * `minBars`, or 0 when even one fold is impossible.
 *
 * Shrinking the fold count is the whole "return fewer folds rather than garbage
 * ones" rule: the alternative is emitting the requested number of windows and
 * letting several of them be too short to trade, which reads as "the strategy
 * failed folds 3, 4 and 5" when the truth is "we never tested folds 3, 4 and 5".
 */
function usableFolds(
  totalBars: number,
  trainBars: number,
  requestedFolds: number,
  minBars: number,
): { folds: number; testSize: number } {
  if (trainBars < minBars) return { folds: 0, testSize: 0 };
  const remaining = totalBars - trainBars;
  for (let f = Math.floor(requestedFolds); f >= 1; f--) {
    const testSize = Math.floor(remaining / f);
    if (testSize >= minBars) return { folds: f, testSize };
  }
  return { folds: 0, testSize: 0 };
}

function normalizeTrainRatio(trainRatio: number | undefined, fallback: number): number {
  if (trainRatio === undefined || !Number.isFinite(trainRatio)) return fallback;
  return Math.min(Math.max(trainRatio, 0.1), 0.95);
}

/**
 * Rolling walk-forward: a fixed-length train window slid forward, each followed
 * immediately by the test window that comes next in time.
 *
 * Test windows are contiguous, equal-length, non-overlapping and strictly
 * forward-ordered, which is what makes the per-fold results independent enough to
 * count: "profitable in 4 of 5 folds" is a real consistency statement, whereas
 * overlapping test windows would just be the same trades counted repeatedly.
 *
 * Train windows DO overlap between folds — that is inherent to sliding a window
 * and is harmless, because train windows are never scored.
 */
export function walkForwardSplits(
  snapshots: MarketSnapshot[],
  opts: WalkForwardOptions = {},
): WalkForwardSplit[] {
  const minBars = opts.minBars ?? MIN_WARMUP_BARS;
  const requested = Math.max(1, Math.floor(opts.folds ?? 4));
  const trainRatio = normalizeTrainRatio(opts.trainRatio, 0.6);
  const n = snapshots.length;

  const trainSize = Math.floor(n * trainRatio);
  const { folds, testSize } = usableFolds(n, trainSize, requested, minBars);
  if (folds === 0) return [];

  const out: WalkForwardSplit[] = [];
  for (let i = 0; i < folds; i++) {
    const trainStart = i * testSize;
    const trainEnd = trainStart + trainSize;
    const testEnd = trainEnd + testSize;
    out.push({
      index: i,
      train: snapshots.slice(trainStart, trainEnd),
      test: snapshots.slice(trainEnd, testEnd),
    });
  }
  return out;
}

/**
 * Anchored walk-forward: the train window always starts at bar 0 and grows by one
 * test window per fold.
 *
 * This is the honest simulation of a live deployment — on any given day you have
 * all of history available, not a 120-bar rolling slice — and it wastes no data,
 * which matters when a series is barely long enough to split at all.
 *
 * Its blind spot is the mirror of the rolling version's: because early history
 * never leaves the train window, a strategy that stopped working three years ago
 * can still look acceptable here. Neither split is sufficient alone.
 */
export function anchoredWalkForward(
  snapshots: MarketSnapshot[],
  opts: WalkForwardOptions = {},
): WalkForwardSplit[] {
  const minBars = opts.minBars ?? MIN_WARMUP_BARS;
  const requested = Math.max(1, Math.floor(opts.folds ?? 4));
  const trainRatio = normalizeTrainRatio(opts.trainRatio, 0.5);
  const n = snapshots.length;

  const initialTrain = Math.floor(n * trainRatio);
  const { folds, testSize } = usableFolds(n, initialTrain, requested, minBars);
  if (folds === 0) return [];

  const out: WalkForwardSplit[] = [];
  for (let i = 0; i < folds; i++) {
    const trainEnd = initialTrain + i * testSize;
    const testEnd = trainEnd + testSize;
    out.push({
      index: i,
      train: snapshots.slice(0, trainEnd),
      test: snapshots.slice(trainEnd, testEnd),
    });
  }
  return out;
}
