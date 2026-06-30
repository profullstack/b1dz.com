import { describe, it, expect } from 'vitest';
import { tsp } from '@b1dz/source-strategies';
import {
  buildDefinition,
  builderStateFromDefinition,
  coerceOperand,
  slugify,
  defaultBuilderState,
  type BuilderState,
} from './tsp-builder';

describe('slugify', () => {
  it('kebab-cases and strips junk', () => {
    expect(slugify('My RSI Dip!! Buyer')).toBe('my-rsi-dip-buyer');
  });
  it('falls back for empty input', () => {
    expect(slugify('   ')).toBe('untitled-strategy');
  });
});

describe('coerceOperand', () => {
  it('keeps numbers numeric and names as strings', () => {
    expect(coerceOperand('30')).toBe(30);
    expect(coerceOperand('-2.5')).toBe(-2.5);
    expect(coerceOperand('rsi14')).toBe('rsi14');
    expect(coerceOperand('price')).toBe('price');
  });
});

describe('buildDefinition (template)', () => {
  it('emits a valid template document', () => {
    const state = defaultBuilderState();
    state.name = 'Mean Rev';
    const doc = buildDefinition(state);
    expect(doc.id).toBe('mean-rev');
    expect(doc.definition).toMatchObject({ kind: 'template', template: 'mean-reversion' });
    expect(tsp.validateDefinition(doc).ok).toBe(true);
  });
});

describe('buildDefinition (rules)', () => {
  function rulesState(): BuilderState {
    const s = defaultBuilderState();
    s.mode = 'rules';
    s.name = 'My RSI';
    return s;
  }

  it('emits a single comparison when a rule has one condition', () => {
    const doc = buildDefinition(rulesState());
    const def = doc.definition as { rules: { when: unknown }[] };
    expect(def.rules[0]!.when).toEqual({ lt: ['rsi14', 30] });
    expect(tsp.validateDefinition(doc).ok).toBe(true);
  });

  it('ANDs multiple conditions together and compiles', () => {
    const s = rulesState();
    s.rules.indicators = [
      { name: 'rsi14', fn: 'rsi', period: 14 },
      { name: 'ema50', fn: 'ema', period: 50 },
    ];
    s.rules.rules = [
      {
        conditions: [
          { left: 'rsi14', op: 'lt', right: '30' },
          { left: 'price', op: 'gt', right: 'ema50' },
        ],
        side: 'buy',
        strength: 0.9,
        reason: 'dip in uptrend',
      },
    ];
    const doc = buildDefinition(s);
    const def = doc.definition as { rules: { when: { and: unknown[] } }[] };
    expect(def.rules[0]!.when.and).toHaveLength(2);
    expect(tsp.validateDefinition(doc).ok).toBe(true);
    // round-trips through the compiler
    expect(() => tsp.compile(doc)).not.toThrow();
  });

  it('omits the indicators key when none are declared', () => {
    const s = rulesState();
    s.rules.indicators = [];
    s.rules.rules = [{ conditions: [{ left: 'price', op: 'gt', right: '0' }], side: 'buy', strength: 1, reason: '' }];
    const doc = buildDefinition(s);
    expect('indicators' in (doc.definition as object)).toBe(false);
    expect(tsp.validateDefinition(doc).ok).toBe(true);
  });
});

describe('builderStateFromDefinition (round-trip)', () => {
  it('hydrates a template document', () => {
    const doc = { tsp: '0.1', id: 'mr', name: 'MR', assetClasses: ['equity'], definition: { kind: 'template', template: 'breakout', params: { lookback: 12 } } };
    const state = builderStateFromDefinition(doc);
    expect(state.mode).toBe('template');
    expect(state.template.template).toBe('breakout');
    expect(state.template.params.lookback).toBe(12);
    expect(state.assetClasses).toEqual(['equity']);
    // and it rebuilds to an equivalent valid doc
    expect(tsp.validateDefinition(buildDefinition(state)).ok).toBe(true);
  });

  it('hydrates a rules document, flattening an AND condition into rows', () => {
    const doc = {
      tsp: '0.1', id: 'r', name: 'R',
      definition: {
        kind: 'rules',
        indicators: { rsi14: { fn: 'rsi', period: 14 }, ema50: { fn: 'ema', period: 50 } },
        rules: [{ when: { and: [{ lt: ['rsi14', 30] }, { gt: ['price', 'ema50'] }] }, signal: { side: 'buy', strength: 0.9, reason: 'dip' } }],
      },
    };
    const state = builderStateFromDefinition(doc);
    expect(state.mode).toBe('rules');
    expect(state.rules.indicators.map((i) => i.name)).toEqual(['rsi14', 'ema50']);
    expect(state.rules.rules[0]!.conditions).toEqual([
      { left: 'rsi14', op: 'lt', right: '30' },
      { left: 'price', op: 'gt', right: 'ema50' },
    ]);
    expect(state.rules.rules[0]!.side).toBe('buy');
    expect(tsp.validateDefinition(buildDefinition(state)).ok).toBe(true);
  });

  it('falls back to defaults for an unrecognized document', () => {
    const state = builderStateFromDefinition({ junk: true });
    expect(state).toEqual(defaultBuilderState());
  });
});
