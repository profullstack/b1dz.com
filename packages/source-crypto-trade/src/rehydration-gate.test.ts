import { afterEach, describe, it, expect } from 'vitest';
import {
  __resetHydrationStateForTests,
  __setLastHydratedAtForTests,
  __lastHydratedAtForTests,
  __shouldRehydrateForTests,
  __REHYDRATE_INTERVAL_MS_FOR_TESTS,
} from './index.js';

afterEach(() => {
  __resetHydrationStateForTests();
});

describe('hydrateFromExchange re-hydration gate', () => {
  it('runs for an exchange that has never hydrated (last = 0)', () => {
    const now = Date.now();
    expect(__shouldRehydrateForTests('kraken', now)).toBe(true);
    expect(__lastHydratedAtForTests('kraken')).toBe(0);
  });

  it('skips an exchange hydrated 1s ago', () => {
    const now = Date.now();
    __setLastHydratedAtForTests('kraken', now - 1000);
    expect(__shouldRehydrateForTests('kraken', now)).toBe(false);
  });

  it('skips an exchange hydrated just under the interval', () => {
    const now = Date.now();
    __setLastHydratedAtForTests('kraken', now - (__REHYDRATE_INTERVAL_MS_FOR_TESTS - 1));
    expect(__shouldRehydrateForTests('kraken', now)).toBe(false);
  });

  it('re-runs an exchange hydrated exactly at the interval boundary', () => {
    const now = Date.now();
    __setLastHydratedAtForTests('kraken', now - __REHYDRATE_INTERVAL_MS_FOR_TESTS);
    expect(__shouldRehydrateForTests('kraken', now)).toBe(true);
  });

  it('re-runs an exchange hydrated long ago (picks up external buys)', () => {
    const now = Date.now();
    __setLastHydratedAtForTests('kraken', now - 60 * 60_000); // 1h ago
    expect(__shouldRehydrateForTests('kraken', now)).toBe(true);
  });

  it('decides each exchange independently', () => {
    const now = Date.now();
    __setLastHydratedAtForTests('kraken', now - 1_000); // fresh
    __setLastHydratedAtForTests('coinbase', now - __REHYDRATE_INTERVAL_MS_FOR_TESTS - 1_000); // stale
    expect(__shouldRehydrateForTests('kraken', now)).toBe(false);
    expect(__shouldRehydrateForTests('coinbase', now)).toBe(true);
    expect(__shouldRehydrateForTests('binance-us', now)).toBe(true); // never hydrated
  });

  it('uses a 5-minute default interval', () => {
    expect(__REHYDRATE_INTERVAL_MS_FOR_TESTS).toBe(5 * 60_000);
  });
});
