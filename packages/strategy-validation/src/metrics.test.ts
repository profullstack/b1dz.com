import { describe, it, expect } from 'vitest';
import { replayStrategy, ZERO_COST_MODEL } from '@b1dz/source-strategies';
import type { StrategyPlugin } from '@b1dz/core';
import {
  DEGENERATE_RATIO_CAP,
  cagr,
  computeMetrics,
  equityCurve,
  excessKurtosis,
  expectancy,
  kurtosis,
  maxDrawdownDuration,
  maxDrawdownPct,
  mean,
  profitFactor,
  sharpe,
  skewness,
  sortino,
  stdev,
  tradeReturns,
  tradeSpanYears,
  tradesPerYear,
  ulcerIndex,
} from './metrics.js';
import { DAY_MS, snapshotsFrom, syntheticTrade, syntheticTrades } from './synthetic.js';

const curve = (equities: number[]) => equities.map((equity, i) => ({ ts: i * DAY_MS, equity }));

describe('mean / stdev', () => {
  it('computes the arithmetic mean', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([-1, 1])).toBe(0);
  });

  it('uses the SAMPLE (n-1) standard deviation', () => {
    // mean 5, sum of squared deviations 32, n 8.
    // sample: sqrt(32/7) = 2.13809; population would be sqrt(32/8) = 2.
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).not.toBeCloseTo(2, 6);
  });

  it('returns 0 rather than NaN for degenerate samples', () => {
    expect(mean([])).toBe(0);
    expect(stdev([])).toBe(0);
    expect(stdev([5])).toBe(0);
    expect(stdev([3, 3, 3])).toBe(0);
  });
});

describe('skewness', () => {
  it('is zero for a symmetric sample', () => {
    expect(skewness([1, 2, 3, 4, 5])).toBeCloseTo(0, 12);
    expect(skewness([-2, -1, 0, 1, 2])).toBeCloseTo(0, 12);
  });

  it('matches the closed form for a known asymmetric sample', () => {
    // [0,0,0,1]: m2 = 3/16, m3 = 3/32, skew = m3/m2^1.5 = 2/sqrt(3).
    expect(skewness([0, 0, 0, 1])).toBeCloseTo(2 / Math.sqrt(3), 10);
  });

  it('is negative for a left-tailed sample (the dangerous shape)', () => {
    // many small wins, one large loss — the payoff profile that flatters Sharpe.
    expect(skewness([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, -0.2])).toBeLessThan(-1);
  });

  it('degrades to 0 for samples too small to have a shape', () => {
    expect(skewness([])).toBe(0);
    expect(skewness([1, 2])).toBe(0);
    expect(skewness([4, 4, 4, 4])).toBe(0);
  });
});

describe('kurtosis', () => {
  it('is NON-excess: a two-point symmetric sample has kurtosis 1', () => {
    expect(kurtosis([-1, -1, 1, 1])).toBeCloseTo(1, 12);
  });

  it('is ~3 for an approximately gaussian sample', () => {
    // 9 points of a discretized normal; not exact, but must sit near 3 and
    // nowhere near 0 — the whole point of the convention.
    const g = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2];
    expect(kurtosis(g)).toBeGreaterThan(1.5);
    expect(kurtosis(g)).toBeLessThan(3);
    expect(excessKurtosis(g)).toBeCloseTo(kurtosis(g) - 3, 12);
  });

  it('is far above 3 for a fat-tailed sample', () => {
    expect(kurtosis([0, 0, 0, 0, 0, 0, 0, 0, 0, 10])).toBeGreaterThan(8);
  });

  it('defaults to the gaussian value (3) when the sample is too small', () => {
    expect(kurtosis([])).toBe(3);
    expect(kurtosis([1, 2, 3])).toBe(3);
    expect(kurtosis([2, 2, 2, 2])).toBe(3);
  });
});

describe('tradeReturns', () => {
  it('extracts net per-trade returns in close order', () => {
    expect(tradeReturns(syntheticTrades([0.01, -0.02, 0.03]))).toEqual([0.01, -0.02, 0.03]);
  });

  it('agrees with what the real backtester produces', () => {
    // Guards against BacktestTrade field drift: if `tradeReturnPct` ever stops
    // being a net fraction of cash deployed, every statistic here is wrong.
    const scripted: StrategyPlugin = {
      manifest: { id: 's', kind: 'strategy', version: '0', name: 'S', capabilities: [] },
      evaluate(_snap, history) {
        if (history.length === 0) return { side: 'buy', strength: 1, reason: 'in' };
        if (history.length === 1) return { side: 'sell', strength: 1, reason: 'out' };
        return null;
      },
    };
    const trades = replayStrategy(scripted, snapshotsFrom([100, 120]), {
      amountPerEntry: 100,
      costs: ZERO_COST_MODEL,
    });
    expect(tradeReturns(trades)).toHaveLength(1);
    expect(tradeReturns(trades)[0]).toBeCloseTo(0.2, 10);
  });

  it('is empty for no trades', () => {
    expect(tradeReturns([])).toEqual([]);
  });
});

describe('equityCurve', () => {
  it('seeds at the first entry then compounds netMultiple per close', () => {
    const trades = syntheticTrades([0.1, -0.1]);
    const c = equityCurve(trades, 1);
    expect(c).toHaveLength(3);
    expect(c[0]!.equity).toBe(1);
    expect(c[0]!.ts).toBe(trades[0]!.entryTs);
    expect(c[1]!.equity).toBeCloseTo(1.1, 12);
    expect(c[2]!.equity).toBeCloseTo(0.99, 12); // 1.1 * 0.9 — compounding, not summing
    expect(c[2]!.ts).toBe(trades[1]!.exitTs);
  });

  it('respects a non-unit starting equity', () => {
    const c = equityCurve(syntheticTrades([0.5]), 1000);
    expect(c[0]!.equity).toBe(1000);
    expect(c[1]!.equity).toBeCloseTo(1500, 9);
  });

  it('floors a total loss at zero instead of going negative', () => {
    const wipeout = syntheticTrade({ profit: -100, cost: 100 });
    const c = equityCurve([wipeout], 1);
    expect(c[1]!.equity).toBe(0);
  });

  it('is empty for no trades', () => {
    expect(equityCurve([], 1)).toEqual([]);
  });
});

describe('sharpe', () => {
  it('matches the closed form at per-observation frequency', () => {
    // mean 0.02, sample sd 0.01 → 2.0 exactly.
    expect(sharpe([0.01, 0.02, 0.03], 1)).toBeCloseTo(2, 12);
  });

  it('annualizes by sqrt(periodsPerYear)', () => {
    expect(sharpe([0.01, 0.02, 0.03], 4)).toBeCloseTo(4, 12);
    expect(sharpe([0.01, 0.02, 0.03], 252)).toBeCloseTo(2 * Math.sqrt(252), 10);
  });

  it('is negative for a losing return stream', () => {
    expect(sharpe([-0.01, -0.02, -0.03], 1)).toBeCloseTo(-2, 12);
  });

  it('returns 0 for degenerate inputs instead of NaN or Infinity', () => {
    expect(sharpe([], 252)).toBe(0);
    expect(sharpe([0.05], 252)).toBe(0);
    expect(sharpe([0.01, 0.01, 0.01], 252)).toBe(0); // zero dispersion
    expect(Number.isFinite(sharpe([0.01, 0.02], 0))).toBe(true);
  });
});

describe('sortino', () => {
  it('divides by the full-n target downside deviation', () => {
    // excess = [0.02, -0.01, 0.03]; mean = 0.0133333
    // downside = sqrt(0.0001/3) = 0.00577350 → ratio 2.309401
    expect(sortino([0.02, -0.01, 0.03], 1)).toBeCloseTo(2.309401, 6);
  });

  it('scores higher than Sharpe when the dispersion is all upside', () => {
    const r = [0.01, 0.02, 0.30, -0.01];
    expect(sortino(r, 1)).toBeGreaterThan(sharpe(r, 1));
  });

  it('honours a non-zero minimum acceptable return', () => {
    // With a 2% target, the 1% "win" becomes a shortfall.
    expect(sortino([0.01, 0.03], 1, 0.02)).toBeCloseTo(0, 12);
    expect(sortino([0.01, 0.01], 1, 0.02)).toBeLessThan(0);
  });

  it('caps rather than returning Infinity when there is no downside', () => {
    expect(sortino([0.01, 0.02, 0.03], 1)).toBe(DEGENERATE_RATIO_CAP);
    expect(sortino([], 1)).toBe(0);
    expect(sortino([-0.01, -0.02], 1)).toBeLessThan(0);
    expect(Number.isFinite(sortino([0, 0, 0], 1))).toBe(true);
  });
});

describe('maxDrawdownPct', () => {
  it('measures the deepest peak-to-trough decline as a fraction', () => {
    expect(maxDrawdownPct(curve([100, 120, 60, 90]))).toBeCloseTo(0.5, 12);
  });

  it('measures from the seed point, so a first losing trade counts', () => {
    expect(maxDrawdownPct(equityCurve(syntheticTrades([-0.3, 0.1]), 1))).toBeCloseTo(0.3, 12);
  });

  it('is 0 for a monotonically rising curve', () => {
    expect(maxDrawdownPct(curve([1, 2, 3, 4]))).toBe(0);
  });

  it('is 1 for a total wipeout and never exceeds 1', () => {
    expect(maxDrawdownPct(curve([100, 0]))).toBe(1);
    expect(maxDrawdownPct(curve([100, 50, 0, 25]))).toBe(1);
  });

  it('handles empty and non-positive curves', () => {
    expect(maxDrawdownPct([])).toBe(0);
    expect(maxDrawdownPct(curve([0, 0]))).toBe(0);
  });
});

describe('maxDrawdownDuration', () => {
  it('counts the longest run spent below a prior peak', () => {
    expect(maxDrawdownDuration(curve([1, 2, 1.5, 1.4, 1.9, 2.5, 2.4]))).toBe(3);
  });

  it('is 0 when the curve never retreats', () => {
    expect(maxDrawdownDuration(curve([1, 1, 2, 3]))).toBe(0);
    expect(maxDrawdownDuration([])).toBe(0);
  });
});

describe('profitFactor', () => {
  it('is gross wins over gross losses', () => {
    const trades = [
      syntheticTrade({ profit: 20 }),
      syntheticTrade({ profit: 10 }),
      syntheticTrade({ profit: -10 }),
    ];
    expect(profitFactor(trades)).toBeCloseTo(3, 12);
  });

  it('is 1 at break-even', () => {
    expect(profitFactor([syntheticTrade({ profit: 10 }), syntheticTrade({ profit: -10 })])).toBe(1);
  });

  it('is below 1 for a fee-generation machine', () => {
    expect(profitFactor([syntheticTrade({ profit: 5 }), syntheticTrade({ profit: -10 })])).toBeCloseTo(0.5, 12);
  });

  it('caps instead of returning Infinity when nothing lost', () => {
    expect(profitFactor([syntheticTrade({ profit: 10 })])).toBe(DEGENERATE_RATIO_CAP);
    expect(profitFactor([])).toBe(0);
    expect(profitFactor([syntheticTrade({ profit: 0 })])).toBe(0);
  });
});

describe('expectancy', () => {
  it('is the mean net return per trade', () => {
    expect(expectancy(syntheticTrades([0.02, -0.01, 0.05]))).toBeCloseTo(0.02, 12);
  });

  it('is negative for a high-win-rate strategy that gives it all back', () => {
    // 9 wins of +1%, one loss of -15%: 90% win rate, negative expectancy.
    const trades = syntheticTrades([...Array<number>(9).fill(0.01), -0.15]);
    expect(trades.filter((t) => t.profit > 0)).toHaveLength(9);
    expect(expectancy(trades)).toBeLessThan(0);
  });

  it('is 0 for no trades', () => {
    expect(expectancy([])).toBe(0);
  });
});

describe('cagr', () => {
  it('matches the closed form', () => {
    expect(cagr(100, 121, 2)).toBeCloseTo(0.1, 12);
    expect(cagr(100, 200, 1)).toBeCloseTo(1, 12);
    expect(cagr(100, 100, 5)).toBeCloseTo(0, 12);
  });

  it('reports a wipeout as -1 rather than NaN', () => {
    // Math.pow(negative, 1/2) is NaN, and a NaN silently passes every
    // `>= threshold` check it is compared against.
    expect(cagr(100, 0, 2)).toBe(-1);
    expect(cagr(100, -50, 2)).toBe(-1);
  });

  it('returns 0 when there is no measurable period or capital', () => {
    expect(cagr(100, 200, 0)).toBe(0);
    expect(cagr(100, 200, -1)).toBe(0);
    expect(cagr(0, 200, 1)).toBe(0);
  });
});

describe('ulcerIndex', () => {
  it('matches the RMS-of-drawdowns closed form', () => {
    // drawdowns 0, 0.1, 0 → sqrt(0.01/3) = 0.0577350
    expect(ulcerIndex(curve([100, 90, 100]))).toBeCloseTo(0.057735, 6);
  });

  it('is 0 for a curve that never draws down', () => {
    expect(ulcerIndex(curve([1, 2, 3]))).toBe(0);
    expect(ulcerIndex([])).toBe(0);
  });

  it('separates a brief dip from a long stay underwater', () => {
    const brief = ulcerIndex(curve([100, 80, 100, 100, 100, 100]));
    const lingering = ulcerIndex(curve([100, 80, 82, 85, 88, 90]));
    expect(lingering).toBeGreaterThan(brief);
    // ...even though both bottom out at the same -20%.
    expect(maxDrawdownPct(curve([100, 80, 100, 100, 100, 100]))).toBeCloseTo(0.2, 12);
    expect(maxDrawdownPct(curve([100, 80, 82, 85, 88, 90]))).toBeCloseTo(0.2, 12);
  });
});

describe('tradeSpanYears / tradesPerYear', () => {
  it('measures the span from first entry to last exit', () => {
    const trades = syntheticTrades([0.01, 0.01], { stepMs: 365.25 * DAY_MS });
    // entry at 0, exit of the second trade at 2 * 365.25 days.
    expect(tradeSpanYears(trades)).toBeCloseTo(2, 9);
    expect(tradesPerYear(trades)).toBeCloseTo(1, 9);
  });

  it('returns 0 for spans that cannot be measured', () => {
    expect(tradeSpanYears([])).toBe(0);
    expect(tradesPerYear([])).toBe(0);
    expect(tradesPerYear([syntheticTrade({ profit: 1, entryTs: 5, exitTs: 5 })])).toBe(0);
  });
});

describe('computeMetrics', () => {
  it('produces a fully finite block for a realistic trade stream', () => {
    const trades = syntheticTrades([0.03, -0.01, 0.02, -0.02, 0.04, 0.01, -0.03, 0.02]);
    const m = computeMetrics(trades, 1);
    expect(m.trades).toBe(8);
    expect(m.sharpePerTrade).toBeCloseTo(sharpe(tradeReturns(trades), 1), 12);
    expect(m.profitFactor).toBeCloseTo(12 / 6, 12);
    expect(m.expectancy).toBeCloseTo(0.0075, 12);
    expect(m.kurtosis).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(m)) {
      expect(Number.isFinite(value), `${key} must be finite`).toBe(true);
    }
  });

  it('annualizes using the observed trade frequency, not a hard-coded 252', () => {
    // 4 trades spread over ~4 years is ~1 observation/year, so the annualized
    // Sharpe must stay close to the per-trade figure — not 16x it.
    const yearly = syntheticTrades([0.1, -0.05, 0.2, 0.05], { stepMs: 365.25 * DAY_MS });
    const m = computeMetrics(yearly, 1);
    expect(m.tradesPerYear).toBeCloseTo(1, 3);
    expect(m.sharpeAnnualized).toBeCloseTo(m.sharpePerTrade, 2);
  });

  it('produces a fully finite block for NO trades at all', () => {
    const m = computeMetrics([], 1);
    for (const [key, value] of Object.entries(m)) {
      expect(Number.isFinite(value), `${key} must be finite`).toBe(true);
    }
    expect(m.trades).toBe(0);
    expect(m.finalEquity).toBe(1);
    expect(m.cagr).toBe(0);
  });

  it('produces a fully finite block for a single trade', () => {
    const m = computeMetrics([syntheticTrade({ profit: 10 })], 1);
    for (const [key, value] of Object.entries(m)) {
      expect(Number.isFinite(value), `${key} must be finite`).toBe(true);
    }
  });

  it('produces a fully finite block for a total wipeout', () => {
    const m = computeMetrics([syntheticTrade({ profit: -100, cost: 100 })], 1);
    for (const [key, value] of Object.entries(m)) {
      expect(Number.isFinite(value), `${key} must be finite`).toBe(true);
    }
    expect(m.finalEquity).toBe(0);
    expect(m.maxDrawdownPct).toBe(1);
  });

  it('survives JSON serialization with no nulls (Infinity would become null)', () => {
    const m = computeMetrics([syntheticTrade({ profit: 10 })], 1);
    const round = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(round)) {
      expect(value, `${key} must survive JSON`).not.toBeNull();
    }
  });
});
