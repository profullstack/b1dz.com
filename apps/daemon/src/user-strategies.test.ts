import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '@b1dz/core';
import { combineStrategies, compileUserStrategies, forAssetClass, type LoadedUserStrategy } from './user-strategies.js';

const def = (id: string, assetClasses: string[]) => ({
  tsp: '0.1',
  id,
  name: id,
  assetClasses,
  definition: { kind: 'template', template: 'mean-reversion', params: {} },
});
const row = (over: Partial<{ id: string; user_id: string; visibility: string; asset_classes: string[]; definition: unknown }>) => ({
  id: 's1',
  user_id: 'me',
  name: 'S',
  visibility: 'private',
  asset_classes: ['crypto'],
  definition: def('s1', ['crypto']),
  ...over,
});

describe('compileUserStrategies', () => {
  it('runs your own private strategies and anyone’s published ones', () => {
    const out = compileUserStrategies('me', [
      row({ id: 'mine' }),
      row({ id: 'theirs-pub', user_id: 'them', visibility: 'published' }),
      row({ id: 'theirs-private', user_id: 'them', visibility: 'private' }),
    ]);
    expect(out.map((s) => s.id)).toEqual(['mine', 'theirs-pub']);
  });

  it('skips a definition that no longer compiles', () => {
    expect(compileUserStrategies('me', [row({ definition: { tsp: '0.1' } })])).toEqual([]);
  });
});

describe('forAssetClass', () => {
  const s = (id: string, assetClasses: ('crypto' | 'equity')[]) => ({ id, assetClasses }) as LoadedUserStrategy;
  it('filters by class; an unclassed strategy runs everywhere', () => {
    const all = [s('c', ['crypto']), s('e', ['equity']), s('any', [])];
    expect(forAssetClass(all, 'crypto').map((x) => x.id)).toEqual(['c', 'any']);
    expect(forAssetClass(all, 'equity').map((x) => x.id)).toEqual(['e', 'any']);
  });
});

describe('combineStrategies', () => {
  const fake = (id: string, sig: { side: 'buy' | 'sell'; strength: number; reason: string } | null) =>
    ({ id, assetClasses: [], name: id, plugin: { manifest: { id } as never, evaluate: () => sig } }) as LoadedUserStrategy;
  const snap = {} as MarketSnapshot;

  it('takes the strongest signal and acts on it at full strength', () => {
    const combined = combineStrategies([
      fake('a', { side: 'buy', strength: 0.2, reason: 'weak' }),
      fake('b', { side: 'sell', strength: 0.4, reason: 'stronger' }),
    ]);
    expect(combined.evaluate(snap, [])).toEqual({ side: 'sell', strength: 1, reason: 'stronger (your strategy)' });
  });

  it('returns null when no strategy signals', () => {
    expect(combineStrategies([fake('a', null)]).evaluate(snap, [])).toBeNull();
  });
});
