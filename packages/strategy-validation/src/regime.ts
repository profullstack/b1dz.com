/**
 * Lightweight market-regime classifier — break the backtest into conditions the
 * strategy actually saw, so a listing isn't just "rode a bull run, ignored a
 * crash".
 *
 * WHY THIS EXISTS
 *
 * Every backtest ever published looks best in hindsight data that trends
 * persistently in one direction. A strategy that returned 80% from March 2020
 * to December 2021 and −62% from Jan 2022 to Dec 2022 is not an 18% annualised
 * strategy — it is a bull strategy with a marketing department that chose the
 * window. A gate that requires profitability in more than one regime forces the
 * listing to prove it works in at least TWO of uptrend / downtrend / ranging /
 * volatile, which catches the single-regime-window problem without needing the
 * window to have been adversarially chosen.
 *
 * THE CLASSIFIER
 *
 * `classifyRegimes()` uses two things every bar already has: an EMA slope (is
 * the trend pointing up or down, and how hard?) and a realised-volatility proxy
 * (how wide did it swing recently?). Together those four quadrants — high/low
 * drift × high/low vol — produce a label that is cheap, stateless, and requires
 * no peek into the future. It is NOT a full Markov-switching model; it is
 * deliberate that it uses only data the strategy itself could have seen at the
 * moment of its own entry signal.
 *
 * This module imports nothing beyond @b1dz/core (ema) because the heavy
 * exchange-specific packages pull in database drivers and infra that do not
 * belong in a stateless validator.
 */
import { ema } from '@b1dz/core';
import type { MarketSnapshot } from '@b1dz/core';
import type { BacktestTrade, BacktestSummary } from '@b1dz/source-strategies';

export type Regime = 'uptrend' | 'downtrend' | 'ranging' | 'volatile';

export interface RegimeClassifierOptions {
  /** EMA period for trend slope. Higher = smoother regime transitions. Default 50. */
  trendPeriod?: number;
  /** Short EMA for per-bar volatility proxy. Default 5. */
  volPeriod?: number;
  /** Annualised % drift needed to count as an uptrend. Default 0.1 (10%/yr). */
  trendThreshold?: number;
  /** Annualised vol at/below which a bar is "calm". Default 0.25 (25%/yr). */
  calmVolThreshold?: number;
}

/**
 * Classify every bar into one of four regimes using only backward-looking data.
 *
 * Regime at bar i is determined by:
 *   1. EMA slope over the last 2 × trendPeriod bars (annualised, T−1 to T).
 *      Positive + steep → trending; near zero → ranging.
 *   2. Short EMA of bar-to-bar log-return magnitude, annualised.
 *      High → the bar is "volatile".
 *
 * The combination:
 *   - uptrend:   slope > +threshold, vol ≤ calm   (orderly grind up)
 *   - downtrend: slope < −threshold, vol ≤ calm   (orderly sell-off)
 *   - ranging:   |slope| ≤ threshold, vol ≤ calm  (sideways chop)
 *   - volatile:  vol > calm                       (disorderly moves in either direction)
 */
export function classifyRegimes(
  snapshots: MarketSnapshot[],
  opts: RegimeClassifierOptions = {},
): Regime[] {
  const trendPeriod = opts.trendPeriod ?? 50;
  const volPeriod = opts.volPeriod ?? 5;
  const trendThreshold = opts.trendThreshold ?? 0.1;
  const calmVolThreshold = opts.calmVolThreshold ?? 0.25;

  if (snapshots.length < trendPeriod + 1) {
    return new Array<Regime>(snapshots.length).fill('ranging');
  }

  // mid prices — mean of bid/ask, safe for zero-spread daily bars.
  const mids = snapshots.map((s) => (s.bid + s.ask) / 2);
  const trendEma = ema(mids, trendPeriod) as number[];

  // per-bar log returns of the mid, for volatility estimation.
  const logRets = mids.map((m, i) => (i > 0 && mids[i - 1]! > 0 ? Math.log(m / mids[i - 1]!) : 0));
  const absLogRets = logRets.map(Math.abs);
  const volEma = ema(absLogRets, volPeriod) as number[];

  const tradingDaysPerYear = 252;
  const dailyThreshold = trendThreshold / tradingDaysPerYear;
  const dailyCalm = calmVolThreshold / Math.sqrt(tradingDaysPerYear);

  const out: Regime[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    if (i < trendPeriod) {
      out.push('ranging');
      continue;
    }
    const slope = (trendEma[i]! - trendEma[i - 1]!) / trendEma[i - 1]!;
    const vol = volEma[i]!;

    if (vol > dailyCalm) {
      out.push('volatile');
    } else if (slope > dailyThreshold) {
      out.push('uptrend');
    } else if (slope < -dailyThreshold) {
      out.push('downtrend');
    } else {
      out.push('ranging');
    }
  }
  return out;
}

export interface RegimeBreakdownEntry {
  regime: Regime;
  trades: number;
  netProfit: number;
  returnPct: number;
  winRate: number;
}

/**
 * Bucket trades by the regime at each trade's ENTRY bar.
 *
 * A trade that entered during an uptrend and exited during a crash was opened
 * by the uptrend regime — that is the condition the strategy chose to enter
 * under, and the result communicates "how does this strategy perform when it
 * behaves this way in this kind of market".
 */
export function regimeBreakdown(
  trades: BacktestTrade[],
  regimes: Regime[],
  snapshots: MarketSnapshot[],
): RegimeBreakdownEntry[] {
  const buckets = new Map<Regime, { count: number; profit: number; costSum: number; wins: number }>();

  for (const regime of ['uptrend', 'downtrend', 'ranging', 'volatile'] as Regime[]) {
    buckets.set(regime, { count: 0, profit: 0, costSum: 0, wins: 0 });
  }

  for (const t of trades) {
    const idx = snapshots.findIndex((s) => s.ts === t.entryTs);
    const regime = idx >= 0 && idx < regimes.length ? regimes[idx]! : ('ranging' as Regime);
    const bucket = buckets.get(regime)!;
    bucket.count++;
    bucket.profit += t.profit;
    bucket.costSum += t.cost;
    if (t.profit > 0) bucket.wins++;
  }

  return Array.from(buckets.entries()).map(([regime, b]) => ({
    regime,
    trades: b.count,
    netProfit: b.profit,
    returnPct: b.costSum > 0 ? b.profit / b.costSum : 0,
    winRate: b.count > 0 ? b.wins / b.count : 0,
  }));
}

export interface RegimeCoverage {
  /** Regimes with at least one trade. */
  regimesTraded: Regime[];
  /** Regimes among those with a positive net profit. */
  profitableRegimes: Regime[];
  /** Whether at least `minProfitableRegimes` regimes were profitable. */
  passed: boolean;
  breakdown: RegimeBreakdownEntry[];
}

/**
 * Decide whether a strategy demonstrated edge across enough market conditions.
 *
 * `minProfitableRegimes` defaults to 2: a strategy must work in at least two
 * regimes. One is a filter for regime-blind money printers, and zero would be
 * no gate at all.
 */
export function regimeCoverage(
  breakdown: RegimeBreakdownEntry[],
  minProfitableRegimes = 2,
): RegimeCoverage {
  const profitableEntries = breakdown.filter((b) => b.trades > 0 && b.returnPct > 0);
  return {
    regimesTraded: breakdown.filter((b) => b.trades > 0).map((b) => b.regime),
    profitableRegimes: profitableEntries.map((b) => b.regime),
    passed: profitableEntries.length >= minProfitableRegimes,
    breakdown,
  };
}
