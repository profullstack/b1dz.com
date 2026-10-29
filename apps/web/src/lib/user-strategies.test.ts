import { describe, expect, it } from 'vitest';
import { authorDisplayName, isDuplicateSlug, isUuid, strategyFieldsFromDefinition } from './user-strategies';

const doc = {
  tsp: '0.1',
  id: 'ai-rsi',
  name: 'AI RSI Dip',
  description: 'Buys oversold dips.',
  assetClasses: ['crypto', 'bonds'],
  definition: { kind: 'template', template: 'mean-reversion', params: { oversold: 35 } },
};

describe('strategyFieldsFromDefinition', () => {
  it('derives the row columns from a valid TSP document', () => {
    const r = strategyFieldsFromDefinition(doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toMatchObject({ slug: 'ai-rsi', name: 'AI RSI Dip', description: 'Buys oversold dips.', asset_classes: ['crypto'] });
    expect(r.fields.definition).toBe(doc);
  });

  it('rejects an invalid document with the validator errors', () => {
    const r = strategyFieldsFromDefinition({ tsp: '0.1', id: 'x', name: 'X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects a slug Postgres would refuse', () => {
    const r = strategyFieldsFromDefinition({ ...doc, id: 'Has Spaces!' });
    expect(r.ok).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(strategyFieldsFromDefinition(null).ok).toBe(false);
    expect(strategyFieldsFromDefinition('x').ok).toBe(false);
  });
});

describe('helpers', () => {
  it('isUuid', () => {
    expect(isUuid('0b0e6a8e-6c1f-4b8e-9a52-2f3d0c9d1e11')).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it('isDuplicateSlug matches unique_violation only', () => {
    expect(isDuplicateSlug({ code: '23505' })).toBe(true);
    expect(isDuplicateSlug({ code: '42501' })).toBe(false);
    expect(isDuplicateSlug(null)).toBe(false);
  });

  it('authorDisplayName never falls back to anything identifying', () => {
    expect(authorDisplayName({ first_name: 'Ada', last_name: 'lovelace' })).toBe('Ada L.');
    expect(authorDisplayName({ first_name: 'Ada', last_name: null })).toBe('Ada');
    expect(authorDisplayName({ first_name: '  ' })).toBe('b1dz user');
    expect(authorDisplayName(null)).toBe('b1dz user');
  });
});
