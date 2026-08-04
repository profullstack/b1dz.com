/**
 * Deterministic synthetic market data and trade streams, for calibrating the
 * validator against known ground truth.
 *
 * A statistical gauntlet is itself a measuring instrument, and an uncalibrated
 * instrument is worse than no instrument: it reports numbers with the same
 * confidence whether or not it is wired up correctly. The only way to know the
 * gauntlet works is to run it on series whose right answer is known in advance:
 *
 *   - `randomWalkPrices()` is the NULL HYPOTHESIS. There is no edge in it, by
 *     construction. Any strategy that "passes" on a random walk is proof that a
 *     gate is broken, and that is the single most valuable test in the package.
 *   - `sinePrices()` contains a real, exploitable mean-reversion edge, so a
 *     mean-reversion strategy MUST pass. If it fails, our gates are so strict
 *     that nothing can ever be listed, which is a different failure but still a
 *     failure.
 *   - `trendPrices()` rewards trend-following and punishes mean reversion, which
 *     is how ./regime.ts gets tested for actually distinguishing regimes.
 *
 * Everything here is seeded (`mulberry32`) rather than using Math.random. A
 * flaky statistical test is indistinguishable from a real statistical finding,
 * so randomness that cannot be replayed has no place anywhere near this code.
 *
 * These are exported from the package (not confined to *.test.ts) on purpose:
 * downstream callers building their own listing policy need the same null-
 * hypothesis baseline to check their thresholds against, and `syntheticTrade()`
 * keeps knowledge of BacktestTrade's field semantics in exactly one place.
 */
import type { MarketSnapshot } from '@b1dz/core';
import type { BacktestTrade } from '@b1dz/source-strategies';

/** One trading day in ms — the default bar spacing. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * mulberry32 — a 32-bit seeded PRNG. Tiny, fast, and good enough for fixtures
 * (it passes gjrand's basic suite). Chosen over an LCG because low-bit LCG
 * output is visibly periodic, and over Math.random because a test we cannot
 * replay is a test we cannot debug.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard normal draw from a uniform generator. */
export function gaussian(rand: () => number): number {
  // Reject exact 0 so log() stays finite.
  const u = rand() || Number.EPSILON;
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SnapshotSeriesOptions {
  startTs?: number;
  stepMs?: number;
  exchange?: string;
  pair?: string;
  assetClass?: 'crypto' | 'equity';
  /**
   * Half-spread as a fraction of price. Default 0 → bid === ask, which is what
   * daily-close history actually looks like and the case ./costs.ts covers with
   * `assumedHalfSpreadBps`.
   */
  halfSpreadPct?: number;
}

/** Turn a price series into a chronological MarketSnapshot stream. */
export function snapshotsFrom(prices: number[], opts: SnapshotSeriesOptions = {}): MarketSnapshot[] {
  const startTs = opts.startTs ?? Date.UTC(2020, 0, 1);
  const stepMs = opts.stepMs ?? DAY_MS;
  const half = opts.halfSpreadPct ?? 0;
  return prices.map((p, i) => ({
    exchange: opts.exchange ?? 'test',
    pair: opts.pair ?? 'X-USD',
    bid: p * (1 - half),
    ask: p * (1 + half),
    bidSize: 1,
    askSize: 1,
    ts: startTs + i * stepMs,
    assetClass: opts.assetClass,
  }));
}

export interface RandomWalkOptions {
  bars: number;
  start?: number;
  /** Per-bar expected log return. 0 = a true martingale, i.e. no edge at all. */
  drift?: number;
  /** Per-bar log-return standard deviation. 0.01 ≈ 1%/day ≈ 16% annualized. */
  vol?: number;
  seed?: number;
}

/**
 * Geometric random walk — the null hypothesis.
 *
 * With `drift: 0` there is provably no exploitable structure: future returns are
 * independent of the past, so every strategy's true expectancy is exactly minus
 * its trading costs. Anything that looks profitable here is overfitting, and the
 * gauntlet's job is to say so.
 */
export function randomWalkPrices(opts: RandomWalkOptions): number[] {
  const { bars, start = 100, drift = 0, vol = 0.01, seed = 42 } = opts;
  const rand = mulberry32(seed);
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < bars; i++) {
    out.push(p);
    p *= Math.exp(drift + vol * gaussian(rand));
  }
  return out;
}

export interface SineOptions {
  bars: number;
  start?: number;
  /** Peak-to-mean swing as a fraction of `start`. 0.1 = ±10%. */
  amplitude?: number;
  /** Bars per full cycle. */
  period?: number;
  /** Per-bar gaussian noise as a fraction of price. */
  noise?: number;
  /** Per-bar exponential drift applied on top of the cycle. */
  drift?: number;
  seed?: number;
}

/**
 * Deterministic oscillation plus noise — a series with a REAL mean-reversion
 * edge. Buy the troughs, sell the peaks, keep the amplitude.
 *
 * Used as the positive control. A gauntlet that rejects a mean-reversion
 * strategy on this data is mis-calibrated, and a package that can only ever say
 * "no" is not a store, it is a wall.
 */
export function sinePrices(opts: SineOptions): number[] {
  const { bars, start = 100, amplitude = 0.1, period = 20, noise = 0, drift = 0, seed = 7 } = opts;
  const rand = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const cycle = 1 + amplitude * Math.sin((2 * Math.PI * i) / period);
    const jitter = noise > 0 ? 1 + noise * gaussian(rand) : 1;
    out.push(start * Math.exp(drift * i) * cycle * jitter);
  }
  return out;
}

export interface TrendOptions {
  bars: number;
  start?: number;
  /** Per-bar log drift. 0.002 ≈ +0.2%/bar, a firm but not absurd trend. */
  driftPerBar?: number;
  noise?: number;
  seed?: number;
}

/** Persistent drift with noise — rewards trend following, punishes fading. */
export function trendPrices(opts: TrendOptions): number[] {
  const { bars, start = 100, driftPerBar = 0.002, noise = 0.004, seed = 11 } = opts;
  const rand = mulberry32(seed);
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < bars; i++) {
    out.push(p);
    p *= Math.exp(driftPerBar + noise * gaussian(rand));
  }
  return out;
}

/** Concatenate price segments, rebasing each to continue from the previous close. */
export function concatPrices(...segments: number[][]): number[] {
  const out: number[] = [];
  for (const seg of segments) {
    if (seg.length === 0) continue;
    if (out.length === 0) {
      out.push(...seg);
      continue;
    }
    const scale = out[out.length - 1]! / seg[0]!;
    for (let i = 1; i < seg.length; i++) out.push(seg[i]! * scale);
  }
  return out;
}

/**
 * Build a BacktestTrade with internally consistent fields from a target profit.
 *
 * Every derived field (`netMultiple`, `tradeReturnPct`, `proceeds`, `cost`) is
 * computed from `profit` and `cost` rather than accepted as input, so a fixture
 * can never express an impossible trade — a −$10 profit with a +2% return would
 * quietly invalidate every metric test built on it.
 */
export function syntheticTrade(opts: {
  profit: number;
  cost?: number;
  entryTs?: number;
  exitTs?: number;
  entryPrice?: number;
  exitPrice?: number;
}): BacktestTrade {
  const cost = opts.cost ?? 100;
  const profit = opts.profit;
  const proceeds = cost + profit;
  const entryTs = opts.entryTs ?? 0;
  const exitTs = opts.exitTs ?? entryTs + DAY_MS;
  const entryPrice = opts.entryPrice ?? 100;
  const exitPrice = opts.exitPrice ?? entryPrice * (proceeds / cost);
  const shares = cost / entryPrice;

  return {
    entryTs,
    exitTs,
    entryPrice,
    exitPrice,
    entryMid: entryPrice,
    exitMid: exitPrice,
    shares,
    notionalUsd: cost,
    cost,
    grossProceeds: proceeds,
    proceeds,
    entryFeeUsd: 0,
    exitFeeUsd: 0,
    feesUsd: 0,
    spreadSlippageUsd: 0,
    totalCostUsd: 0,
    costBps: 0,
    grossProfit: profit,
    profit,
    netMultiple: cost > 0 ? proceeds / cost : 1,
    tradeReturnPct: cost > 0 ? profit / cost : 0,
    entryReason: 'synthetic entry',
    exitReason: 'synthetic exit',
  };
}

/** A trade stream with exactly the given per-trade returns, one bar apart. */
export function syntheticTrades(returns: number[], opts: { cost?: number; startTs?: number; stepMs?: number } = {}): BacktestTrade[] {
  const cost = opts.cost ?? 100;
  const startTs = opts.startTs ?? 0;
  const stepMs = opts.stepMs ?? DAY_MS;
  return returns.map((r, i) =>
    syntheticTrade({
      profit: r * cost,
      cost,
      entryTs: startTs + i * stepMs,
      exitTs: startTs + (i + 1) * stepMs,
    }),
  );
}
