/**
 * Deflated Sharpe Ratio — the multiple-testing correction that makes a paid
 * strategy store defensible.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Generation is free and infinite. We can mint ten thousand TSP documents in a
 * minute, backtest them all, and list the best hundred. That process produces
 * spectacular-looking equity curves *with no edge whatsoever*, and it does so
 * reliably, because picking the maximum of ten thousand noisy estimates is a
 * search for luck, not for skill.
 *
 * Concretely: take 10,000 coin-flip strategies whose TRUE Sharpe is exactly zero
 * and score each on 250 observations. Each estimate has a standard error of
 * roughly 1/sqrt(250) ≈ 0.063 per observation, ≈ 1.0 annualized. The single best
 * of those 10,000 will show an annualized Sharpe near 3.9. Not because it works
 * — because we looked 10,000 times. Publish it with a t-test and it clears any
 * conventional significance threshold with room to spare, since the t-test
 * assumes we ran ONE experiment.
 *
 * Bailey & López de Prado's answer, and this module's job: don't ask "is this
 * Sharpe better than zero", ask "is this Sharpe better than the best you'd
 * expect from N tries at nothing". The first question is nearly free to pass;
 * the second is the only one a buyer should care about.
 *
 * REFERENCES
 *   Bailey, D. H. & López de Prado, M. (2014), "The Deflated Sharpe Ratio:
 *     Correcting for Selection Bias, Backtest Overfitting, and Non-Normality",
 *     Journal of Portfolio Management, 40(5), pp. 94–107.
 *   Bailey, D. H. & López de Prado, M. (2012), "The Sharpe Ratio Efficient
 *     Frontier", Journal of Risk, 15(2), pp. 3–44.  (PSR and MinTRL)
 *   Mertens, E. (2002), "Comments on variance of the IID estimator in Lo (2002)".
 *     (the skew/kurtosis-aware standard error used in the PSR denominator)
 *
 * UNITS — READ THIS BEFORE CALLING ANYTHING HERE
 *
 * Every Sharpe in this module is a PER-OBSERVATION Sharpe, not an annualized
 * one, because `nObservations` and the Sharpe have to describe the same sample.
 * Pass an annualized Sharpe with a per-trade observation count and you overstate
 * significance by sqrt(periodsPerYear) — a factor of ~16 for daily data. That is
 * not a rounding error, it is the difference between "reject" and "list it".
 * Use `sharpe(returns, 1)` from ./metrics.js, or `deannualizeSharpe()` below.
 */

/** Euler–Mascheroni constant, γ. Appears in the Gumbel expected-maximum term. */
export const EULER_MASCHERONI = 0.5772156649015329;

/** Below this many observations the sampling distribution is meaningless. */
export const MIN_OBSERVATIONS_FOR_PSR = 2;

// ── normal distribution primitives ──────────────────────────────────────────

/**
 * Standard normal CDF, Φ(x).
 *
 * Hart's (1968) rational approximation in the form given by Graeme West,
 * "Better Approximations to Cumulative Normal Functions" (Wilmott, 2005).
 * Accurate to roughly double-precision machine epsilon across the whole real
 * line, exactly symmetric, and Φ(0) is exactly 0.5.
 *
 * The commonly copy-pasted Abramowitz & Stegun 26.2.17 polynomial is NOT good
 * enough here: its ~7.5e-8 absolute error means Φ(0) ≠ 0.5, and it breaks the
 * Φ/Φ⁻¹ round trip at the 1e-4 level in the tails — which is precisely where a
 * significance decision at p = 0.95 or p = 0.999 gets made.
 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return 0.5;
  const a = Math.abs(x);
  let tail: number;

  if (a > 37) {
    // exp(-37²/2) underflows; the tail is 0 to double precision.
    tail = 0;
  } else {
    const e = Math.exp(-(a * a) / 2);
    if (a < 7.07106781186547) {
      let n = 3.52624965998911e-2 * a + 0.700383064443688;
      n = n * a + 6.37396220353165;
      n = n * a + 33.912866078383;
      n = n * a + 112.079291497871;
      n = n * a + 221.213596169931;
      n = n * a + 220.206867912376;
      let d = 8.83883476483184e-2 * a + 1.75566716318264;
      d = d * a + 16.064177579207;
      d = d * a + 86.7807322029461;
      d = d * a + 296.564248779674;
      d = d * a + 637.333633378831;
      d = d * a + 793.826512519948;
      d = d * a + 440.413735824752;
      tail = (e * n) / d;
    } else {
      // Continued-fraction tail expansion for the far tail.
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      tail = e / (b * 2.506628274631);
    }
  }

  return x > 0 ? 1 - tail : tail;
}

/** Standard normal PDF, φ(x). */
export function normalPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
}

/**
 * Widest probability we will invert. Φ⁻¹(1 − 1e-16) ≈ 8.2; beyond that the
 * float64 gap between p and 1 is smaller than the representable resolution, so
 * clamping is the only alternative to returning ±Infinity — which would then
 * propagate into a benchmark Sharpe and poison the report.
 */
const PPF_EPS = 1e-16;

// Peter Acklam's rational approximation to Φ⁻¹, relative error < 1.15e-9.
const PPF_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
];
const PPF_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
];
const PPF_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
];
const PPF_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const PPF_P_LOW = 0.02425;

/**
 * Standard normal inverse CDF (quantile), Φ⁻¹(p).
 *
 * Acklam's rational approximation, relative error below 1.15e-9 — three orders
 * of magnitude tighter than any decision we make with it. `p` is clamped to
 * [1e-16, 1−1e-16] so the function is total: `normalPpf(0)` returns a large
 * negative finite number rather than −Infinity, because an Infinity here becomes
 * an Infinity in the expected-maximum Sharpe, which becomes a NaN comparison,
 * which becomes a gate that always passes.
 */
export function normalPpf(p: number): number {
  if (Number.isNaN(p)) return 0;
  const q0 = Math.min(Math.max(p, PPF_EPS), 1 - PPF_EPS);

  if (q0 < PPF_P_LOW) {
    const q = Math.sqrt(-2 * Math.log(q0));
    return (
      (((((PPF_C[0]! * q + PPF_C[1]!) * q + PPF_C[2]!) * q + PPF_C[3]!) * q + PPF_C[4]!) * q +
        PPF_C[5]!) /
      ((((PPF_D[0]! * q + PPF_D[1]!) * q + PPF_D[2]!) * q + PPF_D[3]!) * q + 1)
    );
  }
  if (q0 <= 1 - PPF_P_LOW) {
    const q = q0 - 0.5;
    const r = q * q;
    return (
      ((((((PPF_A[0]! * r + PPF_A[1]!) * r + PPF_A[2]!) * r + PPF_A[3]!) * r + PPF_A[4]!) * r +
        PPF_A[5]!) *
        q) /
      (((((PPF_B[0]! * r + PPF_B[1]!) * r + PPF_B[2]!) * r + PPF_B[3]!) * r + PPF_B[4]!) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - q0));
  return -(
    (((((PPF_C[0]! * q + PPF_C[1]!) * q + PPF_C[2]!) * q + PPF_C[3]!) * q + PPF_C[4]!) * q +
      PPF_C[5]!) /
    ((((PPF_D[0]! * q + PPF_D[1]!) * q + PPF_D[2]!) * q + PPF_D[3]!) * q + 1)
  );
}

// ── standard error of the Sharpe estimator ──────────────────────────────────

/**
 * Mertens' (2002) variance factor for the Sharpe estimator:
 *
 *     1 − γ3·SR + ((γ4 − 1)/4)·SR²
 *
 * Divide by (n − 1) and take the root to get the standard error of the estimate.
 * `γ3` is skewness, `γ4` is NON-EXCESS kurtosis (Gaussian = 3). For a Gaussian
 * sample the expression collapses to the familiar `1 + SR²/2`, which is the
 * arithmetic check that the kurtosis convention is right.
 *
 * Why it must be moment-aware: the term is the price of non-normality. Negative
 * skew (`−γ3·SR` becomes positive) and fat tails (`(γ4−1)/4` grows) both INFLATE
 * the standard error, so a strategy that wins small and often and loses huge and
 * rarely — the classic short-volatility disguise — needs a much higher observed
 * Sharpe to clear the same confidence bar. That is the correct treatment, and a
 * plain t-test does not do it.
 *
 * Non-positive results are impossible for any real distribution (the skew–
 * kurtosis feasibility bound γ4 ≥ γ3² + 1 forces the expression to at least
 * (1 − γ3·SR/2)² ≥ 0), so a non-positive value means the sample moments are
 * infeasible — too few observations to estimate a fourth moment. Rather than
 * manufacture a near-zero denominator and an infinite z-score, we retreat to the
 * normal-theory factor, which is the conservative choice.
 */
export function sharpeVarianceFactor(observedSharpe: number, skewness: number, kurtosis: number): number {
  const sr = observedSharpe;
  // A non-finite Sharpe would make the factor non-finite, which would make the
  // standard error non-finite, which would land a NaN in a stored report. The
  // callers that matter (PSR, DSR) reject a non-finite Sharpe outright; this
  // just keeps the reported standard error a real number.
  if (!Number.isFinite(sr)) return 1;
  const gaussian = 1 + (sr * sr) / 2;
  if (!Number.isFinite(skewness) || !Number.isFinite(kurtosis)) return gaussian;
  const factor = 1 - skewness * sr + ((kurtosis - 1) / 4) * sr * sr;
  return factor > 0 ? factor : gaussian;
}

/**
 * Standard error of a per-observation Sharpe estimate over `nObservations`.
 * Uses the (n − 1) denominator to match the PSR formulation.
 */
export function sharpeStandardError(
  observedSharpe: number,
  nObservations: number,
  skewness = 0,
  kurtosis = 3,
): number {
  if (nObservations < MIN_OBSERVATIONS_FOR_PSR) return 0;
  return Math.sqrt(sharpeVarianceFactor(observedSharpe, skewness, kurtosis) / (nObservations - 1));
}

// ── Probabilistic Sharpe Ratio ──────────────────────────────────────────────

export interface PsrInput {
  /** PER-OBSERVATION Sharpe of the candidate. Not annualized. */
  observedSharpe: number;
  /** PER-OBSERVATION Sharpe to beat. 0 asks only "better than nothing". */
  benchmarkSharpe?: number;
  /** Number of return observations behind `observedSharpe` (e.g. trade count). */
  nObservations: number;
  /** Skewness of those returns. 0 = symmetric. */
  skewness?: number;
  /** NON-EXCESS kurtosis of those returns. 3 = Gaussian. */
  kurtosis?: number;
}

/**
 * Probabilistic Sharpe Ratio — P(true Sharpe > benchmark), given the sample.
 *
 *     PSR(SR*) = Φ[ (ŜR − SR*)·sqrt(n − 1) / sqrt(1 − γ3·ŜR + ((γ4−1)/4)·ŜR²) ]
 *
 * Read it as: "how many standard errors above the benchmark is the observed
 * Sharpe, converted to a probability". It is a one-sided confidence level, so
 * 0.95 means the usual 5% false-positive tolerance.
 *
 * On its own, against a benchmark of 0, PSR is easy to pass and therefore not
 * worth much — that is exactly the single-hypothesis test that backtest
 * overfitting defeats. Its value is as the machinery underneath
 * `deflatedSharpeRatio()`, where the benchmark stops being zero and becomes the
 * score a lucky coin flip would have posted.
 *
 * Returns 0 (no evidence) rather than NaN when there are too few observations.
 * Output is a probability, so it is always in [0, 1] and always finite.
 */
export function probabilisticSharpeRatio(input: PsrInput): number {
  const { observedSharpe, nObservations } = input;
  const benchmarkSharpe = input.benchmarkSharpe ?? 0;
  const skew = input.skewness ?? 0;
  const kurt = input.kurtosis ?? 3;

  if (!Number.isFinite(observedSharpe) || !Number.isFinite(benchmarkSharpe)) return 0;
  if (!(nObservations >= MIN_OBSERVATIONS_FOR_PSR)) return 0;

  const se = sharpeStandardError(observedSharpe, nObservations, skew, kurt);
  if (!(se > 0)) return 0;

  return normalCdf((observedSharpe - benchmarkSharpe) / se);
}

// ── expected maximum Sharpe under the null ──────────────────────────────────

/**
 * Expected maximum of N independent standard normal draws, via the Gumbel
 * (extreme value type I) limit:
 *
 *     E[max_N] ≈ (1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))
 *
 * with γ the Euler–Mascheroni constant. This is the approximation used in Bailey
 * & López de Prado (2014). Accurate to ~2% at N = 10 and better as N grows
 * (N = 1000 gives 3.255 against a true value of 3.241).
 *
 * The intuition worth internalising: the maximum of N standard normals grows
 * like sqrt(2·ln N). It grows WITHOUT BOUND, but only logarithmically. So
 * searching harder always buys you a better-looking backtest, and buying twice
 * as much looking gets you almost nothing extra — which is why the honest fix is
 * to subtract the expected windfall rather than to search less.
 */
export function expectedMaxStandardNormal(nTrials: number): number {
  if (!Number.isFinite(nTrials) || nTrials <= 1) return 0;
  const n = nTrials;
  return (
    (1 - EULER_MASCHERONI) * normalPpf(1 - 1 / n) +
    EULER_MASCHERONI * normalPpf(1 - 1 / (n * Math.E))
  );
}

/**
 * The intuition-carrying number: the PER-OBSERVATION Sharpe the luckiest of
 * `nTrials` genuinely worthless strategies is expected to post.
 *
 *     E[max ŜR] = sqrt(V[ŜR across trials]) · E[max of nTrials standard normals]
 *
 * This is the bar a candidate has to clear to have said anything at all. If you
 * generated 10,000 candidates on 250 observations, `expectedMaxSharpe(10000,
 * 1/250)` ≈ 0.244 per observation ≈ 3.9 annualized. Any candidate from that
 * search reporting an annualized Sharpe of 3 is BELOW what pure noise delivers.
 *
 * `varianceOfTrialSharpes` is the variance of the estimated Sharpes ACROSS the
 * trials, in per-observation units. Under the null (every strategy truly has
 * zero edge) it is 1/nObservations — see `nullVarianceOfTrialSharpes()`. When you
 * have the real trial scores, use their sample variance instead: a heterogeneous
 * candidate pool disperses more than the null, and more dispersion means a higher
 * bar.
 *
 * Returns 0 for a single trial: with no selection there is no selection bias, and
 * the correct benchmark falls back to zero.
 */
export function expectedMaxSharpe(nTrials: number, varianceOfTrialSharpes: number): number {
  if (!(varianceOfTrialSharpes > 0) || !Number.isFinite(varianceOfTrialSharpes)) return 0;
  const e = expectedMaxStandardNormal(nTrials);
  if (!(e > 0)) return 0;
  return Math.sqrt(varianceOfTrialSharpes) * e;
}

/**
 * Variance of trial Sharpes under the null hypothesis that every candidate has a
 * true Sharpe of exactly zero: Var(ŜR) = (1 + ŜR²/2)/n → 1/n at ŜR = 0.
 *
 * The right default when the caller only knows HOW MANY candidates it generated,
 * not what they each scored. Note the direction of the error: real candidate
 * pools are heterogeneous (different templates, different parameters), so their
 * Sharpes disperse MORE than the null, which means the true haircut is LARGER
 * than this default. Treat it as a floor and pass `trialSharpes` when you have
 * them.
 */
export function nullVarianceOfTrialSharpes(nObservations: number): number {
  if (!(nObservations > 0)) return 0;
  return 1 / nObservations;
}

/** Convert an annualized Sharpe to the per-observation units this module needs. */
export function deannualizeSharpe(annualizedSharpe: number, periodsPerYear: number): number {
  if (!(periodsPerYear > 0)) return annualizedSharpe;
  return annualizedSharpe / Math.sqrt(periodsPerYear);
}

/** Convert a per-observation Sharpe to annualized units, for display only. */
export function annualizeSharpe(perObservationSharpe: number, periodsPerYear: number): number {
  if (!(periodsPerYear > 0)) return perObservationSharpe;
  return perObservationSharpe * Math.sqrt(periodsPerYear);
}

// ── Deflated Sharpe Ratio ───────────────────────────────────────────────────

export interface DsrInput {
  /** PER-OBSERVATION Sharpe of the selected candidate. Not annualized. */
  observedSharpe: number;
  /**
   * How many candidates were generated and scored before this one was selected.
   * The single most important input in this package. Pass the REAL number: if a
   * generator produced 8,000 documents and kept 40, `nTrials` is 8,000, not 40
   * and not 1. Under-reporting it is how a store lists noise.
   */
  nTrials: number;
  /** Number of return observations (trades) behind `observedSharpe`. */
  nObservations: number;
  /**
   * Variance of the trial Sharpes in per-observation units. Defaults to the null
   * variance 1/nObservations — see `nullVarianceOfTrialSharpes()`.
   */
  varianceOfTrialSharpes?: number;
  skewness?: number;
  /** NON-EXCESS kurtosis (Gaussian = 3). */
  kurtosis?: number;
}

export interface DsrResult {
  /**
   * THE number. P(true Sharpe > best-of-nTrials-under-the-null). A probability
   * in [0, 1]; require ≥ 0.95 before making a listing claim.
   */
  deflatedSharpeRatio: number;
  /**
   * PSR against a zero benchmark — what a single-hypothesis test would have
   * said. Reported alongside so the size of the selection-bias haircut is
   * visible rather than implied.
   */
  probabilisticSharpeRatio: number;
  /** The benchmark actually used: the Sharpe the luckiest coin flip posts. */
  expectedMaxSharpe: number;
  /** Standard error of the Sharpe estimate, in per-observation units. */
  standardError: number;
  /** How many standard errors the observed Sharpe sits above the benchmark. */
  zScore: number;
  observedSharpe: number;
  nTrials: number;
  nObservations: number;
  varianceOfTrialSharpes: number;
  skewness: number;
  kurtosis: number;
}

/**
 * Deflated Sharpe Ratio — PSR with the benchmark raised from zero to the
 * expected best-of-N under the null.
 *
 *     DSR = PSR( SR* = E[max ŜR over nTrials] )
 *
 * Same sample, same observed Sharpe; the ONLY thing that changes is how many
 * times we looked. That is the whole idea, and it is why `nTrials` must be the
 * true size of the search that produced this candidate — including every
 * parameter sweep, every template variation, and every candidate that was
 * discarded. Trials you don't count are trials you don't pay for, and the bill
 * lands on the buyer.
 *
 * Never throws; every degenerate path returns a finite probability.
 */
export function deflatedSharpeRatio(input: DsrInput): DsrResult {
  const { observedSharpe, nTrials, nObservations } = input;
  const skew = input.skewness ?? 0;
  const kurt = input.kurtosis ?? 3;
  const variance = input.varianceOfTrialSharpes ?? nullVarianceOfTrialSharpes(nObservations);

  const benchmark = expectedMaxSharpe(nTrials, variance);
  const se = sharpeStandardError(observedSharpe, nObservations, skew, kurt);
  const zScore = se > 0 ? (observedSharpe - benchmark) / se : 0;

  return {
    deflatedSharpeRatio: probabilisticSharpeRatio({
      observedSharpe,
      benchmarkSharpe: benchmark,
      nObservations,
      skewness: skew,
      kurtosis: kurt,
    }),
    probabilisticSharpeRatio: probabilisticSharpeRatio({
      observedSharpe,
      benchmarkSharpe: 0,
      nObservations,
      skewness: skew,
      kurtosis: kurt,
    }),
    expectedMaxSharpe: benchmark,
    standardError: se,
    zScore: Number.isFinite(zScore) ? zScore : 0,
    observedSharpe,
    nTrials,
    nObservations,
    varianceOfTrialSharpes: variance,
    skewness: skew,
    kurtosis: kurt,
  };
}

// ── Minimum Track Record Length ─────────────────────────────────────────────

export interface MinTrlInput {
  /** PER-OBSERVATION Sharpe. Not annualized. */
  observedSharpe: number;
  /** Benchmark to beat, per-observation. Pass `expectedMaxSharpe(...)` to
   *  answer "how long until this survives the multiple-testing correction". */
  benchmarkSharpe?: number;
  skewness?: number;
  /** NON-EXCESS kurtosis (Gaussian = 3). */
  kurtosis?: number;
  /** One-sided confidence required. Default 0.95. */
  targetConfidence?: number;
}

/**
 * Minimum Track Record Length — how many observations are needed before an
 * observed Sharpe of this size and shape becomes statistically credible.
 *
 *     MinTRL = 1 + [1 − γ3·ŜR + ((γ4−1)/4)·ŜR²] · ( Φ⁻¹(confidence) / (ŜR − SR*) )²
 *
 * It is the exact algebraic inverse of `probabilisticSharpeRatio()`: at exactly
 * MinTRL observations, PSR equals `targetConfidence`. (There is a test asserting
 * that round trip, because an inverse that isn't one is a silent liar.)
 *
 * This is the number that sets forward-test duration. Given a candidate's
 * observed per-trade Sharpe and its trade frequency, MinTRL converts directly
 * into "track this live for N trades / M months before the listing claim is
 * defensible". It also encodes the brutal scaling law of this business: required
 * length grows with the INVERSE SQUARE of the edge, so halving the Sharpe
 * quadruples the wait.
 *
 * Returns `Number.POSITIVE_INFINITY` when `observedSharpe <= benchmarkSharpe` —
 * no amount of data makes a Sharpe credible if it does not exceed the bar in the
 * first place. That is the mathematically correct answer and callers must handle
 * it (`Number.isFinite` before storing; see `finiteOrNull()` in ./gauntlet.ts).
 * Result is fractional; ceil it for a bar or trade count.
 */
export function minimumTrackRecordLength(input: MinTrlInput): number {
  const { observedSharpe } = input;
  const benchmark = input.benchmarkSharpe ?? 0;
  const skew = input.skewness ?? 0;
  const kurt = input.kurtosis ?? 3;
  const confidence = input.targetConfidence ?? 0.95;

  if (!Number.isFinite(observedSharpe) || !Number.isFinite(benchmark)) {
    return Number.POSITIVE_INFINITY;
  }
  const edge = observedSharpe - benchmark;
  if (!(edge > 0)) return Number.POSITIVE_INFINITY;

  const z = normalPpf(Math.min(Math.max(confidence, PPF_EPS), 1 - PPF_EPS));
  const factor = sharpeVarianceFactor(observedSharpe, skew, kurt);
  return 1 + factor * Math.pow(z / edge, 2);
}
