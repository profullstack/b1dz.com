/**
 * Risk-adjusted performance metrics over a net-of-cost trade list.
 *
 * `summarizeTrades()` in @b1dz/source-strategies answers "how much money did it
 * make". That is the number a seller quotes and it is close to useless on its
 * own: total return says nothing about how much pain you had to sit through to
 * collect it, or whether the result is distinguishable from luck. A strategy
 * that returns 40% with a 60% drawdown and four trades is not a product, it is
 * a coin flip with good PR.
 *
 * So this module produces the *shape* of the return stream — dispersion,
 * downside, drawdown depth, drawdown duration, per-trade expectancy — plus the
 * distributional moments (skew, kurtosis) that ./deflated-sharpe.ts needs to
 * decide whether the Sharpe means anything at all.
 *
 * The failure mode being prevented: every one of these formulas has a zero
 * denominator or a fractional power of a negative number lurking in it, and
 * every one of those produces NaN or Infinity rather than an exception. A NaN
 * silently fails every `>=` comparison, so a NaN metric turns a *blocking*
 * quality gate into a gate that always passes. Infinity survives arithmetic and
 * then becomes `null` on JSON.stringify, so it corrupts a stored report instead
 * of the process that produced it. Both leak all the way to a listing page.
 * Every function here therefore returns a finite number for every input,
 * including no input, and the degenerate branches are named and tested.
 *
 * Conventions, because mixing these up is how confident wrong numbers happen:
 *   - Returns are FRACTIONAL, not percent: 0.02 is +2%. (`tradeReturnPct` on
 *     BacktestTrade is already fractional despite the name.)
 *   - Dispersion uses the SAMPLE standard deviation (n−1 denominator). We are
 *     estimating a population from a sample, and with 30 trades the difference
 *     is ~1.7% of the Sharpe.
 *   - `kurtosis()` is NON-EXCESS (Gaussian = 3), because that is what the
 *     Probabilistic Sharpe Ratio formula expects. Read its doc comment before
 *     wiring it to anything else.
 *   - Annualization is `× sqrt(periodsPerYear)`, and `periodsPerYear` must match
 *     the observation frequency of `returns`. Per-TRADE returns are not daily
 *     returns; pass `1` to get a per-observation figure.
 */
import type { BacktestTrade } from '@b1dz/source-strategies';

/** A point on a compounded equity curve. */
export interface EquityPoint {
  /** Epoch ms of the bar that produced this equity level. */
  ts: number;
  equity: number;
}

/**
 * Finite stand-in for a ratio whose denominator is legitimately zero — a sample
 * with wins and no losses at all.
 *
 * The true answer is +∞ and the true cause is almost always a tiny sample, not
 * a risk-free money machine. Returning 0 would be wrong in the other direction
 * (it reads as "terrible" and would fail a gate that the sample cannot actually
 * fail), and returning Infinity poisons JSON. A large finite number is the only
 * option that is both honest about direction and safe downstream. It is
 * deliberately absurd-looking so it is recognisable in a report as "undefined",
 * not as a real measurement.
 */
export const DEGENERATE_RATIO_CAP = 100;

/** Trading days in a year — the default annualization factor for daily bars. */
export const TRADING_DAYS_PER_YEAR = 252;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Arithmetic mean. Empty → 0. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Sample standard deviation (n−1 denominator). Needs at least 2 observations to
 * mean anything; 0 or 1 observations → 0, which makes every ratio built on it
 * collapse to 0 rather than to NaN.
 */
export function stdev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let ss = 0;
  for (const v of values) ss += (v - m) * (v - m);
  return Math.sqrt(ss / (n - 1));
}

/**
 * Fisher–Pearson sample skewness (third standardized moment, biased/population
 * form: m3 / m2^1.5).
 *
 * Negative skew is the one that matters commercially: a strategy that wins small
 * many times and loses huge occasionally (short volatility, martingale
 * averaging-down, naked premium selling) has a flattering Sharpe and a fat left
 * tail. The PSR formula in ./deflated-sharpe.ts uses this to *penalise* exactly
 * that shape, which is why we compute it rather than assuming normality.
 */
export function skewness(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const m = mean(values);
  let m2 = 0;
  let m3 = 0;
  for (const v of values) {
    const d = v - m;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  if (m2 <= 0) return 0;
  return m3 / Math.pow(m2, 1.5);
}

/**
 * NON-EXCESS kurtosis (fourth standardized moment, m4 / m2²). A Gaussian sample
 * returns ≈ 3, NOT ≈ 0.
 *
 * This convention is not a preference, it is a requirement: Bailey & López de
 * Prado write the PSR denominator as `1 − γ3·SR + ((γ4 − 1)/4)·SR²`, and that
 * term only reduces to the textbook `1 + SR²/2` Gaussian variance when γ4 = 3.
 * Feed it excess kurtosis and the denominator becomes `1 − SR²/4`, which is
 * *smaller* than the Gaussian case — i.e. fat tails would make a strategy look
 * MORE statistically significant. Use `excessKurtosis()` for anything that
 * expects the 0-centred convention.
 */
export function kurtosis(values: number[]): number {
  const n = values.length;
  if (n < 4) return 3;
  const m = mean(values);
  let m2 = 0;
  let m4 = 0;
  for (const v of values) {
    const d = v - m;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;
  if (m2 <= 0) return 3;
  return m4 / (m2 * m2);
}

/** Excess kurtosis (Gaussian = 0). Convenience wrapper; see `kurtosis()`. */
export function excessKurtosis(values: number[]): number {
  return kurtosis(values) - 3;
}

/**
 * Per-trade NET returns on cash deployed, in trade-close order.
 *
 * These are the observations every statistic in this package is built on, and
 * they are per-TRADE, not per-bar or per-day. That distinction drives
 * annualization and drives `nObservations` in the deflated Sharpe: 30 trades is
 * 30 observations no matter how many years they span.
 */
export function tradeReturns(trades: BacktestTrade[]): number[] {
  return trades.map((t) => t.tradeReturnPct);
}

/**
 * Compounded equity curve: one seed point at the first entry, then one point per
 * trade close, multiplying by that trade's `netMultiple` (proceeds / cost).
 *
 * Compounding rather than summing profits is the honest choice for a strategy
 * that will be run with a fixed *fraction* of a bankroll, and it is also the
 * stricter one — a −50% drawdown needs +100% to recover, and an additive curve
 * hides that asymmetry.
 *
 * The seed point exists so drawdown can be measured from the starting capital: a
 * strategy whose very first trade loses 30% has a 30% drawdown, and a curve that
 * begins at the first *exit* would report zero.
 */
export function equityCurve(trades: BacktestTrade[], startingEquity = 1): EquityPoint[] {
  if (trades.length === 0) return [];
  const start = startingEquity > 0 ? startingEquity : 1;
  const out: EquityPoint[] = [{ ts: trades[0]!.entryTs, equity: start }];
  let equity = start;
  for (const t of trades) {
    // netMultiple is 1 for a degenerate zero-cost trade, so equity never hits 0
    // by accident; a real −100% trade still floors the curve at 0 correctly.
    equity *= Math.max(0, t.netMultiple);
    out.push({ ts: t.exitTs, equity });
  }
  return out;
}

/**
 * Annualized Sharpe ratio: mean(returns) / stdev(returns) × sqrt(periodsPerYear).
 *
 * No risk-free rate is subtracted. For per-trade returns on a strategy that is
 * flat most of the time, the cash rate applies to un-deployed capital rather
 * than to the trade, so subtracting it per-trade would be double counting.
 *
 * `periodsPerYear` MUST match the frequency of `returns`. Pass 1 for a raw
 * per-observation Sharpe — that is the unit ./deflated-sharpe.ts requires, and
 * feeding it an annualized number inflates significance by sqrt(252).
 *
 * Degenerate: fewer than 2 observations, or zero dispersion, → 0. Zero
 * dispersion means every trade returned exactly the same amount, which is a
 * fixture or a bug, not an infinite-Sharpe discovery.
 */
export function sharpe(returns: number[], periodsPerYear = TRADING_DAYS_PER_YEAR): number {
  if (returns.length < 2) return 0;
  const sd = stdev(returns);
  if (!(sd > 0)) return 0;
  const scale = periodsPerYear > 0 ? Math.sqrt(periodsPerYear) : 1;
  return (mean(returns) / sd) * scale;
}

/**
 * Annualized Sortino ratio: mean(returns − target) / target-downside-deviation.
 *
 * Sharpe punishes upside dispersion, which is incoherent — nobody has ever
 * complained about an unexpectedly large winner. Sortino replaces the
 * denominator with sqrt(mean(min(r − target, 0)²)), where the mean is over ALL
 * n observations (not just the losing ones). That full-n denominator is the
 * textbook definition and it matters: dividing by the loss count instead would
 * make a strategy look better the fewer losses it had, which is the same
 * small-sample flattery we are trying to remove.
 *
 * Degenerate: no losing observation at all → `DEGENERATE_RATIO_CAP` when the
 * mean is positive (undefined, not infinite), 0 otherwise.
 */
export function sortino(
  returns: number[],
  periodsPerYear = TRADING_DAYS_PER_YEAR,
  target = 0,
): number {
  if (returns.length < 2) return 0;
  const excess = returns.map((r) => r - target);
  let ss = 0;
  for (const e of excess) if (e < 0) ss += e * e;
  const downside = Math.sqrt(ss / returns.length);
  const m = mean(excess);
  const scale = periodsPerYear > 0 ? Math.sqrt(periodsPerYear) : 1;
  if (!(downside > 0)) return m > 0 ? DEGENERATE_RATIO_CAP : 0;
  return (m / downside) * scale;
}

/**
 * Deepest peak-to-trough decline on the equity curve, as a FRACTION (0.25 = a
 * 25% drawdown).
 *
 * Fractional and compounded, so it is comparable across bankroll sizes and
 * across strategies — unlike `BacktestSummary.maxDrawdown`, which is a dollar
 * figure on a fixed per-trade notional and therefore only comparable to itself.
 *
 * This is the number that decides whether a buyer actually holds the strategy
 * long enough to collect its expectancy. Return is theoretical; drawdown is what
 * makes people switch it off at the bottom.
 */
export function maxDrawdownPct(curve: EquityPoint[]): number {
  let peak = 0;
  let worst = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/** Longest run of consecutive curve points spent below a prior peak. */
export function maxDrawdownDuration(curve: EquityPoint[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let run = 0;
  let worst = 0;
  for (const p of curve) {
    if (p.equity >= peak) {
      peak = p.equity;
      run = 0;
    } else {
      run += 1;
      if (run > worst) worst = run;
    }
  }
  return worst;
}

/**
 * Profit factor: gross winnings / gross losses, both net of costs.
 *
 * The cleanest single answer to "is there an edge here", because it is immune to
 * position sizing and to trade count. 1.0 is break-even. Below 1.0 the strategy
 * is a fee-generation machine.
 *
 * Wins and losses are split on NET profit, so a trade that captured 10 bps of
 * price movement and paid 60 bps of friction counts in the loss pile — which is
 * the entire point of running the backtester with a cost model.
 *
 * Degenerate: no losses at all → `DEGENERATE_RATIO_CAP` (undefined, capped);
 * no wins → 0.
 */
export function profitFactor(trades: BacktestTrade[]): number {
  let wins = 0;
  let losses = 0;
  for (const t of trades) {
    if (t.profit > 0) wins += t.profit;
    else if (t.profit < 0) losses -= t.profit;
  }
  if (!(losses > 0)) return wins > 0 ? DEGENERATE_RATIO_CAP : 0;
  return wins / losses;
}

/**
 * Expectancy: mean NET return per trade, as a fraction of cash deployed.
 *
 * The break-even test that win rate cannot fake. A 90%-win-rate strategy with
 * negative expectancy is a strategy that gives back nine small wins on one large
 * loss, and it will be marketed on the 90%.
 */
export function expectancy(trades: BacktestTrade[]): number {
  return mean(tradeReturns(trades));
}

/**
 * Compound annual growth rate from start/end equity over `years`.
 *
 * Guards, in the order they bite:
 *   - `years` ≤ 0 or `startEquity` ≤ 0 → 0 (no measurable period; a division and
 *     a fractional root would both blow up).
 *   - `endEquity` ≤ 0 → −1, i.e. total loss. Left unguarded this computes a
 *     fractional power of a negative number, which is NaN, which then passes
 *     every threshold check it is compared against. A wiped-out strategy
 *     silently clearing a return gate is the exact failure this package exists
 *     to stop.
 */
export function cagr(startEquity: number, endEquity: number, years: number): number {
  if (!(years > 0) || !(startEquity > 0)) return 0;
  if (!(endEquity > 0)) return -1;
  return Math.pow(endEquity / startEquity, 1 / years) - 1;
}

/**
 * Ulcer Index: RMS of the drawdown series, as a FRACTION (not ×100 like the
 * original Martin & McCann formulation — kept fractional for consistency with
 * `maxDrawdownPct`).
 *
 * Max drawdown is a single worst-case sample and is therefore noisy: one bad
 * week defines it. Ulcer integrates depth *and* duration over the whole curve,
 * so it separates "dropped 20% once and recovered immediately" from "sat 15%
 * underwater for two years". The second one is the one buyers abandon.
 */
export function ulcerIndex(curve: EquityPoint[]): number {
  if (curve.length === 0) return 0;
  let peak = 0;
  let ss = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      ss += dd * dd;
    }
  }
  return Math.sqrt(ss / curve.length);
}

/** Elapsed years spanned by a trade list, from first entry to last exit. */
export function tradeSpanYears(trades: BacktestTrade[]): number {
  if (trades.length === 0) return 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const t of trades) {
    if (t.entryTs < first) first = t.entryTs;
    if (t.exitTs > last) last = t.exitTs;
  }
  const span = last - first;
  return span > 0 ? span / MS_PER_YEAR : 0;
}

/**
 * Observations per year implied by a trade list — the correct `periodsPerYear`
 * for annualizing a per-trade Sharpe.
 *
 * Hard-coding 252 for per-trade returns is a common and expensive error: a
 * strategy that takes 30 trades over three years has ~10 observations per year,
 * and annualizing it as if it had 252 overstates the Sharpe by sqrt(25) = 5×.
 *
 * Degenerate: an instantaneous or single-trade span → 0, which makes `sharpe()`
 * fall back to a per-observation figure instead of inventing a frequency.
 */
export function tradesPerYear(trades: BacktestTrade[]): number {
  const years = tradeSpanYears(trades);
  if (!(years > 0)) return 0;
  return trades.length / years;
}

/** Everything above, computed once, for a report block. */
export interface MetricSet {
  trades: number;
  /** Per-observation (per-trade) Sharpe. The unit deflation math requires. */
  sharpePerTrade: number;
  /** Sharpe scaled by the trade frequency actually observed in the data. */
  sharpeAnnualized: number;
  sortinoAnnualized: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownPct: number;
  maxDrawdownDuration: number;
  ulcerIndex: number;
  cagr: number;
  skewness: number;
  /** Non-excess (Gaussian = 3). */
  kurtosis: number;
  spanYears: number;
  tradesPerYear: number;
  finalEquity: number;
}

/** Compute the full metric block from a trade list. Never throws, never NaNs. */
export function computeMetrics(trades: BacktestTrade[], startingEquity = 1): MetricSet {
  const returns = tradeReturns(trades);
  const curve = equityCurve(trades, startingEquity);
  const perYear = tradesPerYear(trades);
  const years = tradeSpanYears(trades);
  const finalEquity = curve.length ? curve[curve.length - 1]!.equity : startingEquity;

  return {
    trades: trades.length,
    sharpePerTrade: sharpe(returns, 1),
    sharpeAnnualized: sharpe(returns, perYear),
    sortinoAnnualized: sortino(returns, perYear),
    profitFactor: profitFactor(trades),
    expectancy: expectancy(trades),
    maxDrawdownPct: maxDrawdownPct(curve),
    maxDrawdownDuration: maxDrawdownDuration(curve),
    ulcerIndex: ulcerIndex(curve),
    cagr: cagr(startingEquity, finalEquity, years),
    skewness: skewness(returns),
    kurtosis: kurtosis(returns),
    spanYears: years,
    tradesPerYear: perYear,
    finalEquity,
  };
}
