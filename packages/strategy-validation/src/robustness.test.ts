import { describe, it, expect } from 'vitest';
import { ZERO_COST_MODEL, tsp } from '@b1dz/source-strategies';
import { sinePrices, snapshotsFrom, randomWalkPrices } from './synthetic.js';
import {
  DEFAULT_PERTURBATION_PCT,
  cloneDefinition,
  collectKnobs,
  perturbDefinition,
  robustnessScore,
} from './robustness.js';

const mr = (params: Record<string, number> = {}) => ({
  tsp: '0.1' as const,
  id: 'test-mr',
  name: 'Test MR',
  definition: {
    kind: 'template' as const,
    template: 'mean-reversion' as const,
    params: { period: 14, oversold: 35, overbought: 65, ...params },
  },
});

describe('perturbDefinition', () => {
  it('produces 2 variants per numeric knob (±pct)', () => {
    const variants = perturbDefinition(mr());
    expect(variants).toHaveLength(6);
    for (const v of variants) {
      expect(v.label).toMatch(/→/);
      expect(v.from).not.toBe(v.to);
    }
  });

  it('describes the knob and direction in the label', () => {
    const variants = perturbDefinition(mr());
    const labels = variants.map((v) => v.label);
    expect(labels.some((l) => l.includes('14→'))).toBe(true);
    expect(labels.some((l) => l.includes('+10%'))).toBe(true);
    expect(labels.some((l) => l.includes('-10%'))).toBe(true);
  });

  it('rounds integer knobs and floors at 2', () => {
    const variants = perturbDefinition(mr({ period: 2 }));
    const periodVariants = variants.filter((v) => v.label.includes('period'));
    expect(periodVariants.length).toBeLessThanOrEqual(2);
  });

  it('respects maxVariants cap', () => {
    const many = perturbDefinition(mr(), { maxVariants: 3 });
    expect(many.length).toBeLessThanOrEqual(3);
  });

  it('respects custom pct', () => {
    const variants = perturbDefinition(mr(), { pct: 0.2 });
    expect(variants.some((v) => v.label.includes('20%'))).toBe(true);
  });

  it('yields an empty array for a document with no numeric params', () => {
    const empty: tsp.TradingStrategyDefinition = {
      tsp: '0.1',
      id: 'e',
      name: 'E',
      definition: { kind: 'template', template: 'mean-reversion', params: {} },
    };
    expect(perturbDefinition(empty)).toEqual([]);
  });
});

describe('cloneDefinition', () => {
  it('produces a deep copy that can be mutated independently', () => {
    const doc = mr();
    const copy = cloneDefinition(doc);
    (copy as any).id = 'changed';
    (copy as any).definition.params.period = 99;
    expect(doc.id).toBe('test-mr');
    expect((copy as any).id).toBe('changed');
    expect((doc.definition.params as Record<string, number>).period).toBe(14);
    expect((copy as any).definition.params.period).toBe(99);
  });
});

describe('collectKnobs', () => {
  it('finds every numeric parameter in a template doc', () => {
    const knobs = collectKnobs(mr());
    expect(knobs.length).toBe(3);
    const labels = knobs.map((k) => k.label);
    expect(labels).toContain('definition.params.period');
    expect(labels).toContain('definition.params.oversold');
    expect(labels).toContain('definition.params.overbought');
  });

  it('marks window keys (period, lookback, fast, slow, signal) as integer', () => {
    const knobs = collectKnobs(mr());
    const periodKnob = knobs.find((k) => k.label.endsWith('period'))!;
    expect(periodKnob.integer).toBe(true);
    const oversoldKnob = knobs.find((k) => k.label.endsWith('oversold'))!;
    expect(oversoldKnob.integer).toBe(false);
  });

  it('skips zero-valued operands (sign tests, not fitted thresholds)', () => {
    const rules: tsp.TradingStrategyDefinition = {
      tsp: '0.1',
      id: 'r',
      name: 'R',
      definition: {
        kind: 'rules',
        indicators: { r14: { fn: 'rsi', period: 14 } },
        rules: [{ when: { lt: ['r14', 0] }, signal: { side: 'buy' } }],
      } as any,
    };
    const knobs = collectKnobs(rules);
    const zeroKnobs = knobs.filter((k) => k.value === 0);
    expect(zeroKnobs.length).toBe(0);
  });

  it('collects numeric literals from conditions', () => {
    const doc: tsp.TradingStrategyDefinition = {
      tsp: '0.1',
      id: 'c',
      name: 'C',
      definition: {
        kind: 'rules',
        indicators: { r14: { fn: 'rsi', period: 14 } },
        rules: [{ when: { gt: ['r14', 70] }, signal: { side: 'sell' } }],
      } as any,
    };
    const knobs = collectKnobs(doc);
    const periodKnob = knobs.find((k) => k.path.join('.') === 'definition.indicators.r14.period');
    const thresholdKnob = knobs.find((k) => k.value === 70);
    expect(periodKnob).toBeDefined();
    expect(thresholdKnob).toBeDefined();
    expect(thresholdKnob!.value).toBe(70);
  });
});

describe('robustnessScore', () => {
  const sineSnaps = snapshotsFrom(sinePrices({ bars: 400, period: 20, amplitude: 0.1, noise: 0.01 }));

  it('runs a clean mean-reversion strategy over sine data without throwing', () => {
    const report = robustnessScore(mr(), sineSnaps, { costs: ZERO_COST_MODEL });
    expect(report.variants.length).toBeGreaterThan(0);
    expect(report.baseTrades).toBeGreaterThanOrEqual(0);
    expect(typeof report.baseReturnPct).toBe('number');
    expect(typeof report.passed).toBe('boolean');
  });

  it('runs on random walk data without throwing', () => {
    const rwSnaps = snapshotsFrom(randomWalkPrices({ bars: 400 }));
    const report = robustnessScore(mr(), rwSnaps, { costs: ZERO_COST_MODEL });
    expect(report.variants.length).toBeGreaterThan(0);
    expect(Number.isFinite(report.baseReturnPct)).toBe(true);
  });

  it('reports degradation correctly', () => {
    const report = robustnessScore(mr(), sineSnaps, { costs: ZERO_COST_MODEL });
    expect(typeof report.degradationPct).toBe('number');
    expect(Number.isFinite(report.degradationPct)).toBe(true);
    expect(report.degradationPct).toBeGreaterThanOrEqual(-100);
    expect(report.degradationPct).toBeLessThanOrEqual(100);
  });

  it('ignores identical-to-base variants in the score', () => {
    const bo: tsp.TradingStrategyDefinition = {
      tsp: '0.1',
      id: 'bo',
      name: 'BO',
      definition: {
        kind: 'template',
        template: 'breakout',
        params: { lookback: 20, period: 14 },
      },
    };
    const report = robustnessScore(bo, sineSnaps, { costs: ZERO_COST_MODEL });
    const noops = report.variants.filter((v) => v.identicalToBase);
    expect(noops.length).toBeGreaterThanOrEqual(2);
  });

  it('fails with a doc that cannot compile', () => {
    const bad = { ...mr(), definition: { kind: 'rules' as const, rules: [] } };
    const report = robustnessScore(bad as any, sineSnaps, { costs: ZERO_COST_MODEL });
    expect(report.passed).toBe(false);
    expect(report.detail).toBeTruthy();
  });

  it('reports passed=false when there are no effective variants', () => {
    const emptyDoc: tsp.TradingStrategyDefinition = {
      tsp: '0.1',
      id: 'nv',
      name: 'NV',
      definition: { kind: 'template', template: 'mean-reversion', params: {} },
    };
    const report = robustnessScore(emptyDoc, sineSnaps, { costs: ZERO_COST_MODEL });
    expect(report.passed).toBe(false);
    expect(report.effectiveVariants).toBe(0);
  });

  it('reports every finite value on empty snapshots', () => {
    const report = robustnessScore(mr(), []);
    expect(report.passed).toBe(false);
    expect(Number.isFinite(report.baseReturnPct)).toBe(true);
    expect(Number.isFinite(report.degradationPct)).toBe(true);
    // variants are generated from the document, not from snapshots
    expect(report.variants.length).toBe(6);
    expect(report.baseTrades).toBe(0);
  });
});
