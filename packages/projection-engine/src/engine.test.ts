import { describe, it, expect } from 'vitest';
import { calculateProjection } from './engine.js';

describe('calculateProjection', () => {
  it('linear bankroll grows at fixed rate', () => {
    const result = calculateProjection({ startingBankroll: 300, hourlyProfit: 0.5, days: 1 });
    const day1 = result.series.linear[1]!;
    expect(day1.bankroll).toBeCloseTo(300 + 0.5 * 24, 5);
  });

  it('naive compound exceeds linear by day 30', () => {
    const result = calculateProjection({ startingBankroll: 300, hourlyProfit: 0.5, days: 30 });
    const linear30 = result.series.linear[30]!.bankroll;
    const naive30 = result.series.naiveCompounded[30]!.bankroll;
    expect(naive30).toBeGreaterThan(linear30);
  });

  it('risk-adjusted with fees is lower than naive', () => {
    const result = calculateProjection({
      startingBankroll: 300, hourlyProfit: 0.5, days: 30,
      feeRate: 0.01, slippageRate: 0.005,
    });
    const naive30 = result.series.naiveCompounded[30]!.bankroll;
    const risk30 = result.series.riskAdjusted[30]!.bankroll;
    expect(risk30).toBeLessThan(naive30);
  });

  it('liquidity cap prevents unbounded growth', () => {
    const result = calculateProjection({
      startingBankroll: 300, hourlyProfit: 0.5, days: 365, liquidityCap: 1000,
    });
    const risk365 = result.series.riskAdjusted[365]!.bankroll;
    expect(risk365).toBeLessThan(100_000);
  });

  it('derived metrics are correct', () => {
    const result = calculateProjection({ startingBankroll: 300, hourlyProfit: 0.5, days: 30 });
    expect(result.derived.hourlyReturnRate).toBeCloseTo(0.5 / 300, 8);
    expect(result.derived.dailyFlatProfit).toBeCloseTo(12, 5);
    expect(result.derived.weeklyFlatProfit).toBeCloseTo(84, 5);
  });

  it('warns on extreme annual return', () => {
    const result = calculateProjection({ startingBankroll: 300, hourlyProfit: 0.5, days: 365 });
    const hasCritical = result.warnings.some((w) => w.severity === 'critical');
    expect(hasCritical).toBe(true);
  });

  it('checkpoints include standard days', () => {
    const result = calculateProjection({ startingBankroll: 300, hourlyProfit: 0.5, days: 365 });
    const days = result.checkpoints.map((c) => c.day);
    expect(days).toContain(0);
    expect(days).toContain(30);
    expect(days).toContain(365);
  });

  it('scalingFactor=0 makes conservative equal linear', () => {
    const result = calculateProjection({
      startingBankroll: 300, hourlyProfit: 0.5, days: 30, scalingFactor: 0,
    });
    const linear30 = result.series.linear[30]!.bankroll;
    const cons30 = result.series.conservative[30]!.bankroll;
    expect(cons30).toBeCloseTo(linear30, 4);
  });
});
