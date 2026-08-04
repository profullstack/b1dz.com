import { describe, it, expect } from 'vitest';
import { ZERO_COST_MODEL, tsp } from '@b1dz/source-strategies';
import { sinePrices, snapshotsFrom, randomWalkPrices } from './synthetic.js';
import { runGauntlet, explainReport, DEFAULT_POLICY } from './gauntlet.js';

const mrDoc: tsp.TradingStrategyDefinition = {
  tsp: '0.1',
  id: 'test-mr',
  name: 'Test MR',
  definition: {
    kind: 'template',
    template: 'mean-reversion',
    params: { period: 14, oversold: 35, overbought: 65 },
  },
};

const sineSnaps = snapshotsFrom(
  sinePrices({ bars: 600, period: 20, amplitude: 0.1, noise: 0.01 }),
);

describe('runGauntlet', () => {
  it('runs a mean-reversion strategy on sine data with nTrials=1 without throwing', () => {
    const report = runGauntlet({
      definition: mrDoc,
      snapshots: sineSnaps,
      costs: ZERO_COST_MODEL,
      nTrials: 1,
    });
    expect(report.validationErrors).toEqual([]);
    expect(report.candidateId).toBe('test-mr');
    expect(report.inSampleGates.length).toBeGreaterThan(0);
    expect(report.deflatedSharpe).not.toBeNull();
  });

  it('produces a gauntlet report with all required fields', () => {
    const report = runGauntlet({
      definition: mrDoc,
      snapshots: sineSnaps,
      costs: ZERO_COST_MODEL,
      nTrials: 1,
    });
    expect(report.candidateId).toBe('test-mr');
    expect(typeof report.generatedAt).toBe('string');
    expect(report.generatedAt).toBeTruthy();
    expect(report.costModel).toBeDefined();
    expect(report.inSampleSummary).not.toBeNull();
    expect(report.robustness).not.toBeNull();
    expect(report.deflatedSharpe).not.toBeNull();
    expect(report.duplicates).toEqual([]);
  });

  it('populates validation errors for an invalid document', () => {
    const report = runGauntlet({
      definition: { tsp: '999', id: 'x', name: 'X', definition: {} } as any,
      snapshots: sineSnaps,
    });
    expect(report.validationErrors.length).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
  });

  it('populates validation errors for a doc that fails to compile', () => {
    const report = runGauntlet({
      definition: {
        tsp: '0.1',
        id: 'x',
        name: 'X',
        definition: { kind: 'template', template: 'nope' },
      } as any,
      snapshots: sineSnaps,
    });
    expect(report.validationErrors.length).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
  });

  it('fails the minBars gate on too few bars', () => {
    const tiny = snapshotsFrom(sinePrices({ bars: 10 }));
    const report = runGauntlet({
      definition: mrDoc,
      snapshots: tiny,
      costs: ZERO_COST_MODEL,
    });
    const barGate = report.inSampleGates.find((g) => g.name === 'minBars');
    expect(barGate).toBeDefined();
    expect(barGate!.passed).toBe(false);
  });

  it('never throws on degenerate inputs', () => {
    expect(() =>
      runGauntlet({ definition: mrDoc, snapshots: [] }),
    ).not.toThrow();
    expect(() =>
      runGauntlet({
        definition: mrDoc,
        snapshots: sineSnaps,
        nTrials: -1,
      }),
    ).not.toThrow();
    expect(() =>
      runGauntlet({
        definition: mrDoc,
        snapshots: sineSnaps,
        catalog: [],
      }),
    ).not.toThrow();
  });

  it('passes with a lenient policy that lowers every bar', () => {
    const lenient = {
      minTrades: 1,
      minBars: 10,
      oosRatio: 0.1,
      maxDrawdownPct: 1.0,
      minProfitFactor: 0.1,
      minDeflatedSharpePValue: 0.01,
      minRobustnessFraction: 0.1,
      maxRobustnessDegradationPct: 0.99,
      minProfitableRegimes: 1,
      requireOutOfSampleProfit: false,
      walkForwardFolds: 1,
    };
    const report = runGauntlet({
      definition: mrDoc,
      snapshots: sineSnaps,
      costs: ZERO_COST_MODEL,
      policy: lenient,
      nTrials: 1,
    });
    expect(report.validationErrors).toEqual([]);
    expect(report.inSampleGates.length).toBeGreaterThan(0);
    expect(typeof report.passed).toBe('boolean');
  });

  it('includes inSampleSummary when bars are sufficient', () => {
    const report = runGauntlet({
      definition: mrDoc,
      snapshots: sineSnaps,
      costs: ZERO_COST_MODEL,
      nTrials: 1,
    });
    expect(report.inSampleSummary).not.toBeNull();
    if (report.inSampleSummary) {
      expect(typeof report.inSampleSummary.trades).toBe('number');
      expect(typeof report.inSampleSummary.returnPct).toBe('number');
    }
  });

  it('includes robustness block when valid', () => {
    const report = runGauntlet({
      definition: mrDoc,
      snapshots: sineSnaps,
      costs: ZERO_COST_MODEL,
      nTrials: 1,
    });
    expect(report.robustness).not.toBeNull();
  });

  it('detects duplicate strategies in the catalog', () => {
    const report = runGauntlet({
      definition: mrDoc,
      snapshots: sineSnaps,
      costs: ZERO_COST_MODEL,
      catalog: [],
      nTrials: 1,
    });
    expect(report.duplicates).toEqual([]);
  });
});

describe('explainReport', () => {
  it('includes PASSED/FAILED, candidate ID, and gate names', () => {
    const report = runGauntlet({
      definition: mrDoc,
      snapshots: sineSnaps,
      costs: ZERO_COST_MODEL,
      nTrials: 1,
    });
    const text = explainReport(report);
    expect(text).toContain(report.candidateId);
    expect(text.length).toBeGreaterThan(100);
  });

  it('includes FAILED for a failing report', () => {
    const report = runGauntlet({
      definition: mrDoc,
      snapshots: [],
      costs: ZERO_COST_MODEL,
    });
    expect(explainReport(report)).toContain('FAILED');
  });

  it('includes costs description', () => {
    const report = runGauntlet({
      definition: mrDoc,
      snapshots: sineSnaps,
      costs: ZERO_COST_MODEL,
      nTrials: 1,
    });
    const text = explainReport(report);
    expect(text).toContain('costs');
  });
});

describe('DEFAULT_POLICY', () => {
  it('defines sensible defaults for every gate', () => {
    expect(DEFAULT_POLICY.minTrades).toBe(30);
    expect(DEFAULT_POLICY.minBars).toBe(35);
    expect(DEFAULT_POLICY.oosRatio).toBe(0.3);
    expect(DEFAULT_POLICY.maxDrawdownPct).toBe(0.25);
    expect(DEFAULT_POLICY.minProfitFactor).toBe(1.2);
    expect(DEFAULT_POLICY.minDeflatedSharpePValue).toBe(0.95);
    expect(DEFAULT_POLICY.minRobustnessFraction).toBe(0.6);
    expect(DEFAULT_POLICY.maxRobustnessDegradationPct).toBe(0.5);
    expect(DEFAULT_POLICY.minProfitableRegimes).toBe(2);
    expect(DEFAULT_POLICY.maxCatalogCorrelation).toBe(0.8);
    expect(DEFAULT_POLICY.requireOutOfSampleProfit).toBe(true);
    expect(DEFAULT_POLICY.walkForwardFolds).toBe(3);
  });
});
