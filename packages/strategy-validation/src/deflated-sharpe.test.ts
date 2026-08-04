import { describe, it, expect } from 'vitest';
import {
  EULER_MASCHERONI,
  annualizeSharpe,
  deannualizeSharpe,
  deflatedSharpeRatio,
  expectedMaxSharpe,
  expectedMaxStandardNormal,
  minimumTrackRecordLength,
  normalCdf,
  normalPdf,
  normalPpf,
  nullVarianceOfTrialSharpes,
  probabilisticSharpeRatio,
  sharpeStandardError,
  sharpeVarianceFactor,
} from './deflated-sharpe.js';

describe('normalCdf', () => {
  it('matches published values of the standard normal CDF', () => {
    // Abramowitz & Stegun Table 26.1 / any statistics table.
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(0.5)).toBeCloseTo(0.6914624613, 10);
    expect(normalCdf(1)).toBeCloseTo(0.8413447461, 10);
    expect(normalCdf(1.6448536270)).toBeCloseTo(0.95, 10);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021049, 10);
    expect(normalCdf(2)).toBeCloseTo(0.977249868, 9);
    expect(normalCdf(2.5758293035)).toBeCloseTo(0.995, 10);
    expect(normalCdf(3)).toBeCloseTo(0.998650102, 9);
    expect(normalCdf(3.0902323062)).toBeCloseTo(0.999, 10);
  });

  it('is accurate in the far tails, where significance decisions are made', () => {
    // Compared as RELATIVE error: an absolute tolerance is meaningless against a
    // number of order 1e-16.
    expect(normalCdf(-5) / 2.866515719e-7).toBeCloseTo(1, 9);
    expect(normalCdf(-8) / 6.220960574e-16).toBeCloseTo(1, 7);
    expect(normalCdf(-3.0902323062) / 0.001).toBeCloseTo(1, 9);
  });

  it('is exactly symmetric', () => {
    for (let i = -400; i <= 400; i += 7) {
      const x = i / 100;
      expect(normalCdf(x) + normalCdf(-x)).toBe(1);
    }
  });

  it('saturates without overflowing', () => {
    expect(normalCdf(40)).toBe(1);
    expect(normalCdf(-40)).toBe(0);
    expect(normalCdf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalCdf(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normalCdf(Number.NaN)).toBe(0.5);
  });

  it('is bounded to [0, 1] for every input', () => {
    for (let i = -2000; i <= 2000; i += 13) {
      const p = normalCdf(i / 100);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('normalPdf', () => {
  it('matches the closed form at known points', () => {
    expect(normalPdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 12);
    expect(normalPdf(1)).toBeCloseTo(0.2419707245, 10);
    expect(normalPdf(-1)).toBeCloseTo(0.2419707245, 10);
  });
});

describe('normalPpf', () => {
  it('matches published normal quantiles', () => {
    expect(normalPpf(0.5)).toBeCloseTo(0, 9);
    expect(normalPpf(0.75)).toBeCloseTo(0.6744897502, 8);
    expect(normalPpf(0.9)).toBeCloseTo(1.2815515655, 8);
    expect(normalPpf(0.95)).toBeCloseTo(1.644853627, 8);
    expect(normalPpf(0.975)).toBeCloseTo(1.9599639845, 8);
    expect(normalPpf(0.99)).toBeCloseTo(2.326347874, 8);
    expect(normalPpf(0.995)).toBeCloseTo(2.5758293035, 8);
    expect(normalPpf(0.999)).toBeCloseTo(3.0902323062, 8);
    expect(normalPpf(0.0001)).toBeCloseTo(-3.7190164854, 7);
  });

  it('inverts normalCdf to within the approximation error', () => {
    for (let i = -450; i <= 450; i += 9) {
      const x = i / 100;
      expect(normalPpf(normalCdf(x))).toBeCloseTo(x, 6);
    }
  });

  it('is inverted by normalCdf across the probability range', () => {
    for (let i = 1; i < 1000; i += 3) {
      const p = i / 1000;
      expect(normalCdf(normalPpf(p))).toBeCloseTo(p, 8);
    }
  });

  it('clamps instead of returning +/-Infinity at the boundaries', () => {
    // An Infinity here would flow into the expected-max Sharpe, then into a
    // NaN comparison, then into a blocking gate that always passes.
    expect(Number.isFinite(normalPpf(0))).toBe(true);
    expect(Number.isFinite(normalPpf(1))).toBe(true);
    expect(normalPpf(0)).toBeLessThan(-8);
    expect(normalPpf(1)).toBeGreaterThan(8);
    expect(normalPpf(-5)).toBe(normalPpf(0));
    expect(normalPpf(17)).toBe(normalPpf(1));
    expect(normalPpf(Number.NaN)).toBe(0);
  });
});

describe('sharpeVarianceFactor', () => {
  it('collapses to the gaussian 1 + SR^2/2 when skew=0 and kurtosis=3', () => {
    // This is the arithmetic proof that `kurtosis` is the NON-EXCESS convention.
    expect(sharpeVarianceFactor(0, 0, 3)).toBeCloseTo(1, 12);
    expect(sharpeVarianceFactor(1, 0, 3)).toBeCloseTo(1.5, 12);
    expect(sharpeVarianceFactor(2, 0, 3)).toBeCloseTo(3, 12);
  });

  it('inflates the standard error for negative skew and fat tails', () => {
    const gaussian = sharpeVarianceFactor(0.5, 0, 3);
    expect(sharpeVarianceFactor(0.5, -1.5, 3)).toBeGreaterThan(gaussian); // left tail
    expect(sharpeVarianceFactor(0.5, 0, 12)).toBeGreaterThan(gaussian); // fat tails
    // ...so the same observed Sharpe is LESS significant once shape is accounted for.
    const clean = probabilisticSharpeRatio({ observedSharpe: 0.5, nObservations: 40 });
    const ugly = probabilisticSharpeRatio({
      observedSharpe: 0.5,
      nObservations: 40,
      skewness: -1.5,
      kurtosis: 12,
    });
    expect(ugly).toBeLessThan(clean);
  });

  it('retreats to the gaussian factor when sample moments are infeasible', () => {
    // skew 3 at SR 1 gives 1 - 3 + 0.5 = -1.5, impossible for a real
    // distribution; an epsilon floor here would manufacture an infinite z-score.
    expect(sharpeVarianceFactor(1, 3, 3)).toBe(sharpeVarianceFactor(1, 0, 3));
    expect(Number.isFinite(sharpeVarianceFactor(1, 3, 3))).toBe(true);
    expect(sharpeVarianceFactor(1, Number.NaN, Number.NaN)).toBe(1.5);
  });
});

describe('sharpeStandardError', () => {
  it('is ~1/sqrt(n) for a zero Sharpe, the classic result', () => {
    expect(sharpeStandardError(0, 251, 0, 3)).toBeCloseTo(1 / Math.sqrt(250), 12);
  });

  it('shrinks with sqrt of the sample size', () => {
    const a = sharpeStandardError(0.2, 101);
    const b = sharpeStandardError(0.2, 401);
    expect(a / b).toBeCloseTo(2, 6);
  });

  it('is 0 for samples too small to have a sampling distribution', () => {
    expect(sharpeStandardError(1, 1)).toBe(0);
    expect(sharpeStandardError(1, 0)).toBe(0);
  });
});

describe('probabilisticSharpeRatio', () => {
  it('is exactly 0.5 when the observed Sharpe equals the benchmark', () => {
    expect(
      probabilisticSharpeRatio({ observedSharpe: 0.3, benchmarkSharpe: 0.3, nObservations: 100 }),
    ).toBe(0.5);
  });

  it('matches a hand-computed z-score', () => {
    // SR 0.2, n 101, gaussian: se = sqrt((1 + 0.02)/100) = 0.1009950
    // z = 0.2/0.1009950 = 1.980295 → Phi(z) = 0.976164
    const se = Math.sqrt((1 + 0.2 * 0.2 / 2) / 100);
    expect(sharpeStandardError(0.2, 101)).toBeCloseTo(se, 12);
    expect(probabilisticSharpeRatio({ observedSharpe: 0.2, nObservations: 101 })).toBeCloseTo(
      normalCdf(0.2 / se),
      12,
    );
    expect(probabilisticSharpeRatio({ observedSharpe: 0.2, nObservations: 101 })).toBeCloseTo(
      0.9761648,
      6,
    );
  });

  it('rises with sample size for the same observed Sharpe', () => {
    const short = probabilisticSharpeRatio({ observedSharpe: 0.15, nObservations: 20 });
    const long = probabilisticSharpeRatio({ observedSharpe: 0.15, nObservations: 400 });
    expect(short).toBeLessThan(long);
    expect(short).toBeLessThan(0.95);
    expect(long).toBeGreaterThan(0.99);
  });

  it('falls below 0.5 when the observed Sharpe is under the benchmark', () => {
    expect(
      probabilisticSharpeRatio({ observedSharpe: 0.1, benchmarkSharpe: 0.3, nObservations: 100 }),
    ).toBeLessThan(0.5);
  });

  it('returns 0 (no evidence) rather than NaN on degenerate input', () => {
    expect(probabilisticSharpeRatio({ observedSharpe: 2, nObservations: 1 })).toBe(0);
    expect(probabilisticSharpeRatio({ observedSharpe: 2, nObservations: 0 })).toBe(0);
    expect(probabilisticSharpeRatio({ observedSharpe: Number.NaN, nObservations: 100 })).toBe(0);
    expect(
      probabilisticSharpeRatio({
        observedSharpe: 1,
        benchmarkSharpe: Number.POSITIVE_INFINITY,
        nObservations: 100,
      }),
    ).toBe(0);
  });
});

describe('expectedMaxStandardNormal', () => {
  it('approximates the true expected maximum of N standard normals', () => {
    // True values (Monte Carlo / order statistics): N=10 → 1.539, N=100 → 2.508,
    // N=1000 → 3.241. The Gumbel approximation runs ~1-2% high, as documented.
    expect(expectedMaxStandardNormal(10)).toBeCloseTo(1.5746, 3);
    expect(expectedMaxStandardNormal(100)).toBeCloseTo(2.5306, 3);
    expect(expectedMaxStandardNormal(1000)).toBeCloseTo(3.2551, 3);
    expect(expectedMaxStandardNormal(10)).toBeGreaterThan(1.5);
    expect(expectedMaxStandardNormal(10)).toBeLessThan(1.62);
    expect(expectedMaxStandardNormal(1000)).toBeGreaterThan(3.2);
    expect(expectedMaxStandardNormal(1000)).toBeLessThan(3.32);
  });

  it('grows like sqrt(2 ln N) — without bound, but only logarithmically', () => {
    // The sqrt(2 ln N) asymptote is approached from below, so the ratio must be
    // under 1 everywhere and must climb monotonically toward it.
    let prevRatio = 0;
    for (const n of [10, 100, 1000, 10_000, 1e6, 1e9]) {
      const ratio = expectedMaxStandardNormal(n) / Math.sqrt(2 * Math.log(n));
      expect(ratio).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1);
      expect(ratio).toBeGreaterThan(prevRatio);
      prevRatio = ratio;
    }
    // Doubling the search buys very little extra luck...
    const gain = expectedMaxStandardNormal(2000) - expectedMaxStandardNormal(1000);
    expect(gain).toBeGreaterThan(0);
    expect(gain).toBeLessThan(0.2);
    // ...but it never stops growing.
    expect(expectedMaxStandardNormal(1e12)).toBeGreaterThan(expectedMaxStandardNormal(1e6));
  });

  it('is monotonically increasing in N', () => {
    let prev = 0;
    for (const n of [2, 3, 5, 10, 50, 100, 500, 1000, 5000, 100_000]) {
      const e = expectedMaxStandardNormal(n);
      expect(e).toBeGreaterThan(prev);
      prev = e;
    }
  });

  it('is 0 for a single trial (no selection, no selection bias)', () => {
    expect(expectedMaxStandardNormal(1)).toBe(0);
    expect(expectedMaxStandardNormal(0)).toBe(0);
    expect(expectedMaxStandardNormal(-5)).toBe(0);
    expect(expectedMaxStandardNormal(Number.POSITIVE_INFINITY)).toBe(0);
    expect(expectedMaxStandardNormal(Number.NaN)).toBe(0);
  });

  it('uses the Euler-Mascheroni weighting from Bailey & Lopez de Prado (2014)', () => {
    const n = 500;
    const expected =
      (1 - EULER_MASCHERONI) * normalPpf(1 - 1 / n) +
      EULER_MASCHERONI * normalPpf(1 - 1 / (n * Math.E));
    expect(expectedMaxStandardNormal(n)).toBeCloseTo(expected, 12);
  });
});

describe('expectedMaxSharpe', () => {
  it('scales with the standard deviation of the trial Sharpes', () => {
    const base = expectedMaxSharpe(1000, 1);
    expect(expectedMaxSharpe(1000, 4)).toBeCloseTo(base * 2, 10);
    expect(expectedMaxSharpe(1000, 0.25)).toBeCloseTo(base / 2, 10);
  });

  it('quantifies the noise bar: 10,000 trials on 250 observations', () => {
    // Per-observation bar...
    const bar = expectedMaxSharpe(10_000, nullVarianceOfTrialSharpes(250));
    expect(bar).toBeCloseTo(3.8607 / Math.sqrt(250), 4);
    // ...which is an ANNUALIZED Sharpe of ~3.9 for daily data, from pure noise.
    expect(annualizeSharpe(bar, 252)).toBeGreaterThan(3.8);
    expect(annualizeSharpe(bar, 252)).toBeLessThan(4.0);
  });

  it('is 0 when there is nothing to correct for', () => {
    expect(expectedMaxSharpe(1, 0.01)).toBe(0);
    expect(expectedMaxSharpe(1000, 0)).toBe(0);
    expect(expectedMaxSharpe(1000, -1)).toBe(0);
    expect(expectedMaxSharpe(1000, Number.NaN)).toBe(0);
  });
});

describe('nullVarianceOfTrialSharpes', () => {
  it('is 1/n, the sampling variance of a zero-edge Sharpe estimate', () => {
    expect(nullVarianceOfTrialSharpes(250)).toBeCloseTo(0.004, 12);
    expect(Math.sqrt(nullVarianceOfTrialSharpes(100))).toBeCloseTo(0.1, 12);
  });

  it('is 0 for a non-existent sample', () => {
    expect(nullVarianceOfTrialSharpes(0)).toBe(0);
    expect(nullVarianceOfTrialSharpes(-3)).toBe(0);
  });
});

describe('deannualizeSharpe / annualizeSharpe', () => {
  it('round-trips through sqrt(periodsPerYear)', () => {
    expect(deannualizeSharpe(2, 252)).toBeCloseTo(2 / Math.sqrt(252), 12);
    expect(annualizeSharpe(deannualizeSharpe(2, 252), 252)).toBeCloseTo(2, 12);
  });

  it('passes the value through when the frequency is unknown', () => {
    expect(deannualizeSharpe(1.7, 0)).toBe(1.7);
    expect(annualizeSharpe(1.7, 0)).toBe(1.7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The reason this module exists.
// ─────────────────────────────────────────────────────────────────────────────

describe('deflatedSharpeRatio — best-of-N deflation', () => {
  /**
   * An annualized Sharpe of 2.0 on 250 daily observations. Respectable, and the
   * kind of number an AI generator produces by the thousand.
   */
  const OBSERVATIONS = 250;
  const observedSharpe = deannualizeSharpe(2.0, 252); // ≈ 0.126 per observation

  it('PASSES when it is the result of a single honest experiment', () => {
    const r = deflatedSharpeRatio({ observedSharpe, nTrials: 1, nObservations: OBSERVATIONS });
    expect(r.expectedMaxSharpe).toBe(0); // nothing to deflate
    expect(r.deflatedSharpeRatio).toBe(r.probabilisticSharpeRatio);
    expect(r.deflatedSharpeRatio).toBeGreaterThan(0.95);
    expect(r.deflatedSharpeRatio).toBeCloseTo(0.9761, 3);
  });

  it('FAILS on the SAME numbers when it was the best of 1,000 candidates', () => {
    const r = deflatedSharpeRatio({ observedSharpe, nTrials: 1000, nObservations: OBSERVATIONS });

    // The luckiest of 1,000 zero-edge strategies posts ~3.26 annualized...
    expect(annualizeSharpe(r.expectedMaxSharpe, 252)).toBeGreaterThan(3.2);
    // ...so our 2.0 is BELOW the noise bar and the z-score goes negative.
    expect(r.expectedMaxSharpe).toBeGreaterThan(r.observedSharpe);
    expect(r.zScore).toBeLessThan(0);

    expect(r.deflatedSharpeRatio).toBeLessThan(0.95);
    expect(r.deflatedSharpeRatio).toBeLessThan(0.2);
    expect(r.deflatedSharpeRatio).toBeCloseTo(0.1043, 3);

    // The undeflated single-hypothesis test still says "significant" — which is
    // exactly the mistake this module exists to prevent.
    expect(r.probabilisticSharpeRatio).toBeGreaterThan(0.95);
  });

  it('deflates monotonically as the search widens', () => {
    let prev = 1;
    for (const nTrials of [1, 2, 10, 100, 1000, 10_000, 1_000_000]) {
      const r = deflatedSharpeRatio({ observedSharpe, nTrials, nObservations: OBSERVATIONS });
      expect(r.deflatedSharpeRatio).toBeLessThanOrEqual(prev);
      prev = r.deflatedSharpeRatio;
    }
    expect(prev).toBeLessThan(0.01); // a million tries buys any Sharpe you like
  });

  it('lets a genuinely exceptional strategy survive a wide search', () => {
    // Sharpe 6 annualized on 250 days is a real anomaly, not a lucky draw...
    const exceptional = deflatedSharpeRatio({
      observedSharpe: deannualizeSharpe(6, 252),
      nTrials: 1000,
      nObservations: OBSERVATIONS,
    });
    expect(exceptional.deflatedSharpeRatio).toBeGreaterThan(0.95);
    // ...and a package that could only ever say "no" would be a wall, not a store.
  });

  it('needs more observations to justify the same Sharpe after a wide search', () => {
    // Same 2.0 annualized Sharpe, best-of-1000, but ten years of data instead of one.
    const long = deflatedSharpeRatio({
      observedSharpe,
      nTrials: 1000,
      nObservations: 2520,
    });
    expect(long.deflatedSharpeRatio).toBeGreaterThan(0.95);
    // The noise bar falls as 1/sqrt(n): more data, less room for luck.
    const short = deflatedSharpeRatio({ observedSharpe, nTrials: 1000, nObservations: 250 });
    expect(long.expectedMaxSharpe).toBeLessThan(short.expectedMaxSharpe);
  });

  it('uses the caller-supplied trial variance when the real spread is known', () => {
    const wide = deflatedSharpeRatio({
      observedSharpe,
      nTrials: 1000,
      nObservations: OBSERVATIONS,
      varianceOfTrialSharpes: 4 * nullVarianceOfTrialSharpes(OBSERVATIONS),
    });
    const nullish = deflatedSharpeRatio({
      observedSharpe,
      nTrials: 1000,
      nObservations: OBSERVATIONS,
    });
    // A more dispersed candidate pool means a higher bar, so a bigger haircut.
    expect(wide.expectedMaxSharpe).toBeCloseTo(nullish.expectedMaxSharpe * 2, 10);
    expect(wide.deflatedSharpeRatio).toBeLessThan(nullish.deflatedSharpeRatio);
  });

  it('penalises the short-volatility payoff shape once the Sharpe clears the bar', () => {
    const strong = deannualizeSharpe(6, 252);
    const clean = deflatedSharpeRatio({
      observedSharpe: strong,
      nTrials: 100,
      nObservations: OBSERVATIONS,
    });
    const skewed = deflatedSharpeRatio({
      observedSharpe: strong,
      nTrials: 100,
      nObservations: OBSERVATIONS,
      skewness: -2.5,
      kurtosis: 15,
    });
    expect(clean.observedSharpe).toBeGreaterThan(clean.expectedMaxSharpe);
    expect(skewed.standardError).toBeGreaterThan(clean.standardError);
    expect(skewed.deflatedSharpeRatio).toBeLessThan(clean.deflatedSharpeRatio);
  });

  it('lets extra uncertainty cut both ways below the bar — by design, not by bug', () => {
    // A subtlety worth stating explicitly, because it looks wrong at a glance:
    // when the observed Sharpe sits BELOW the noise bar, a wider standard error
    // pulls the probability back toward 0.5 and therefore UP. That is correct
    // Bayesian bookkeeping — a fat-tailed sample is less informative about being
    // below the bar too. The result is still a failing DSR either way, so no
    // listing decision turns on it.
    const clean = deflatedSharpeRatio({ observedSharpe, nTrials: 1000, nObservations: OBSERVATIONS });
    const skewed = deflatedSharpeRatio({
      observedSharpe,
      nTrials: 1000,
      nObservations: OBSERVATIONS,
      skewness: -2.5,
      kurtosis: 15,
    });
    expect(clean.observedSharpe).toBeLessThan(clean.expectedMaxSharpe);
    expect(skewed.deflatedSharpeRatio).toBeGreaterThan(clean.deflatedSharpeRatio);
    expect(skewed.deflatedSharpeRatio).toBeLessThan(0.5);
    expect(clean.deflatedSharpeRatio).toBeLessThan(0.5);
  });

  it('reports every field finite and JSON-safe on degenerate input', () => {
    for (const input of [
      { observedSharpe: 0, nTrials: 0, nObservations: 0 },
      { observedSharpe: Number.NaN, nTrials: 1000, nObservations: 100 },
      { observedSharpe: 5, nTrials: 1, nObservations: 1 },
      { observedSharpe: -1, nTrials: 1e12, nObservations: 3 },
      { observedSharpe: 1, nTrials: 1000, nObservations: 100, varianceOfTrialSharpes: 0 },
    ]) {
      const r = deflatedSharpeRatio(input);
      for (const [key, value] of Object.entries(r)) {
        if (key === 'observedSharpe') continue; // echoed back verbatim
        expect(Number.isFinite(value), `${key} finite for ${JSON.stringify(input)}`).toBe(true);
      }
      expect(r.deflatedSharpeRatio).toBeGreaterThanOrEqual(0);
      expect(r.deflatedSharpeRatio).toBeLessThanOrEqual(1);
    }
  });
});

describe('minimumTrackRecordLength', () => {
  it('matches the closed form', () => {
    // SR 0.1, gaussian, 95%: 1 + 1.005 * (1.6448536/0.1)^2 = 272.91
    const z = normalPpf(0.95);
    const expected = 1 + 1.005 * Math.pow(z / 0.1, 2);
    expect(minimumTrackRecordLength({ observedSharpe: 0.1 })).toBeCloseTo(expected, 9);
    expect(minimumTrackRecordLength({ observedSharpe: 0.1 })).toBeCloseTo(272.91, 1);
  });

  it('is the exact inverse of probabilisticSharpeRatio', () => {
    // If MinTRL is not the inverse of PSR then one of them is lying, and both
    // are used to make listing decisions.
    for (const [sr, skew, kurt, conf] of [
      [0.1, 0, 3, 0.95],
      [0.25, -1.2, 8, 0.99],
      [0.05, 0.6, 4.5, 0.9],
      [0.4, -0.3, 3.2, 0.999],
    ] as const) {
      const n = minimumTrackRecordLength({
        observedSharpe: sr,
        skewness: skew,
        kurtosis: kurt,
        targetConfidence: conf,
      });
      expect(Number.isFinite(n)).toBe(true);
      expect(
        probabilisticSharpeRatio({
          observedSharpe: sr,
          nObservations: n,
          skewness: skew,
          kurtosis: kurt,
        }),
      ).toBeCloseTo(conf, 8);
    }
  });

  it('grows with the inverse square of the edge', () => {
    const strong = minimumTrackRecordLength({ observedSharpe: 0.2 });
    const half = minimumTrackRecordLength({ observedSharpe: 0.1 });
    // Halving the edge roughly quadruples the required track record.
    expect((half - 1) / (strong - 1)).toBeGreaterThan(3.8);
    expect((half - 1) / (strong - 1)).toBeLessThan(4.2);
  });

  it('demands more data at higher confidence', () => {
    const c90 = minimumTrackRecordLength({ observedSharpe: 0.15, targetConfidence: 0.9 });
    const c99 = minimumTrackRecordLength({ observedSharpe: 0.15, targetConfidence: 0.99 });
    expect(c99).toBeGreaterThan(c90);
  });

  it('demands more data for a negatively skewed, fat-tailed return stream', () => {
    const clean = minimumTrackRecordLength({ observedSharpe: 0.15 });
    const ugly = minimumTrackRecordLength({ observedSharpe: 0.15, skewness: -2, kurtosis: 12 });
    expect(ugly).toBeGreaterThan(clean);
    // The required length scales exactly with the variance factor: 1.361875
    // versus the gaussian 1.01125, a 35% longer track record for the same Sharpe.
    expect((ugly - 1) / (clean - 1)).toBeCloseTo(
      sharpeVarianceFactor(0.15, -2, 12) / sharpeVarianceFactor(0.15, 0, 3),
      9,
    );
    expect((ugly - 1) / (clean - 1)).toBeCloseTo(1.3467, 3);
  });

  it('answers the forward-test question against the deflated benchmark', () => {
    // "How long must we track this live before the best-of-1000 claim holds?"
    const observedSharpe = deannualizeSharpe(2.0, 252);
    const bar = expectedMaxSharpe(1000, nullVarianceOfTrialSharpes(250));
    // Against a zero benchmark, one year of daily data is already enough...
    expect(minimumTrackRecordLength({ observedSharpe })).toBeLessThan(250);
    // ...but it can never clear the best-of-1000 bar, because it sits below it.
    expect(minimumTrackRecordLength({ observedSharpe, benchmarkSharpe: bar })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('returns Infinity when the Sharpe does not exceed the benchmark', () => {
    expect(minimumTrackRecordLength({ observedSharpe: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(minimumTrackRecordLength({ observedSharpe: -0.5 })).toBe(Number.POSITIVE_INFINITY);
    expect(
      minimumTrackRecordLength({ observedSharpe: 0.2, benchmarkSharpe: 0.2 }),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(minimumTrackRecordLength({ observedSharpe: Number.NaN })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
