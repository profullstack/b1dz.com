import { describe, it, expect } from 'vitest';
import {
  decideSeed,
  recordSeed,
  evaluateCircuitBreakers,
  normalizeSeedState,
  emptySeedState,
  stableBalanceOf,
  pickStableToSpend,
  seedKey,
  SEED_PER_PAIR_USD,
  SEED_GLOBAL_USD,
  SEED_COOLDOWN_MS,
  SEED_MIN_USD,
  SEED_EVAL_WINDOW_MS,
  SEED_PAUSE_MS,
  SEED_PROFIT_RATIO,
} from './seeder.js';

const BASE_INPUT = {
  key: 'binance-us:DOGE-USD',
  exchange: 'binance-us',
  pair: 'DOGE-USD',
  currentBaseInventory: 0,
  stableBalanceOnExchange: 1000, // plenty
  nowMs: 1_700_000_000_000,
  tradingEnabled: true,
  state: emptySeedState(),
  refPriceUsd: 0.1,
};

describe('decideSeed — hard guarantees', () => {
  it('refuses when trading is disabled (kill switch honored)', () => {
    const d = decideSeed({ ...BASE_INPUT, tradingEnabled: false });
    expect(d.kind).toBe('disabled');
  });

  it('short-circuits when inventory is already above the min threshold', () => {
    const d = decideSeed({
      ...BASE_INPUT,
      currentBaseInventory: 100, // 100 DOGE × $0.10 = $10 ≥ $5 min
    });
    expect(d.kind).toBe('inventory-ready');
  });

  it('never seeds when stable balance is below SEED_MIN_USD (won\'t sell base)', () => {
    const d = decideSeed({ ...BASE_INPUT, stableBalanceOnExchange: 1 });
    expect(d.kind).toBe('no-stable-balance');
  });

  it('caps seed size at per-pair budget', () => {
    const d = decideSeed(BASE_INPUT);
    expect(d.kind).toBe('seed');
    if (d.kind !== 'seed') return;
    expect(d.sizeUsd).toBeLessThanOrEqual(SEED_PER_PAIR_USD);
  });

  it('caps seed size at 50% of available stable balance (leaves arb engine room)', () => {
    const d = decideSeed({ ...BASE_INPUT, stableBalanceOnExchange: 40 });
    expect(d.kind).toBe('seed');
    if (d.kind !== 'seed') return;
    expect(d.sizeUsd).toBeLessThanOrEqual(20); // 50% of $40
  });
});

describe('decideSeed — budget gates', () => {
  it('blocks re-seeding once per-pair budget is exhausted', () => {
    const key = seedKey('binance-us', 'DOGE-USD');
    const state = {
      entries: {
        [key]: {
          key,
          lastSeededAtMs: BASE_INPUT.nowMs - SEED_COOLDOWN_MS - 1,
          lastSeedCostUsd: SEED_PER_PAIR_USD,
          totalSeedCostUsd: SEED_PER_PAIR_USD,
          pausedUntilMs: 0,
        },
      },
      totalSeedCostUsd: SEED_PER_PAIR_USD,
    };
    const d = decideSeed({ ...BASE_INPUT, state });
    expect(d.kind).toBe('budget-pair-exhausted');
  });

  it('blocks all seeds once global budget is exhausted, even for untouched pairs', () => {
    const state = {
      entries: {
        'binance-us:BTC-USD': {
          key: 'binance-us:BTC-USD',
          lastSeededAtMs: BASE_INPUT.nowMs - SEED_COOLDOWN_MS - 1,
          lastSeedCostUsd: SEED_GLOBAL_USD,
          totalSeedCostUsd: SEED_GLOBAL_USD,
          pausedUntilMs: 0,
        },
      },
      totalSeedCostUsd: SEED_GLOBAL_USD,
    };
    // DOGE has its own fresh per-pair slot, but global is maxed.
    const d = decideSeed({ ...BASE_INPUT, state });
    expect(d.kind).toBe('budget-global-exhausted');
  });
});

describe('decideSeed — cooldown', () => {
  it('blocks re-seeding a pair inside the cooldown window', () => {
    const key = seedKey('binance-us', 'DOGE-USD');
    const state = {
      entries: {
        [key]: {
          key,
          lastSeededAtMs: BASE_INPUT.nowMs - 60_000, // 1 min ago
          lastSeedCostUsd: 10,
          totalSeedCostUsd: 10,
          pausedUntilMs: 0,
        },
      },
      totalSeedCostUsd: 10,
    };
    const d = decideSeed({ ...BASE_INPUT, state });
    expect(d.kind).toBe('cooldown');
    if (d.kind !== 'cooldown') return;
    expect(d.remainingMs).toBeGreaterThan(0);
    expect(d.remainingMs).toBeLessThan(SEED_COOLDOWN_MS);
  });

  it('allows re-seeding once the cooldown elapses', () => {
    const key = seedKey('binance-us', 'DOGE-USD');
    const state = {
      entries: {
        [key]: {
          key,
          lastSeededAtMs: BASE_INPUT.nowMs - SEED_COOLDOWN_MS - 1_000,
          lastSeedCostUsd: 10,
          totalSeedCostUsd: 10,
          pausedUntilMs: 0,
        },
      },
      totalSeedCostUsd: 10,
    };
    const d = decideSeed({ ...BASE_INPUT, state });
    expect(d.kind).toBe('seed');
  });
});

describe('decideSeed — circuit breaker', () => {
  it('blocks re-seeding when the pair is currently paused', () => {
    const key = seedKey('binance-us', 'DOGE-USD');
    const state = {
      entries: {
        [key]: {
          key,
          lastSeededAtMs: BASE_INPUT.nowMs - (SEED_EVAL_WINDOW_MS + 1),
          lastSeedCostUsd: 10,
          totalSeedCostUsd: 10,
          pausedUntilMs: BASE_INPUT.nowMs + 60_000, // 1 min from now
          pauseReason: 'underperforming',
        },
      },
      totalSeedCostUsd: 10,
    };
    const d = decideSeed({ ...BASE_INPUT, state });
    expect(d.kind).toBe('paused');
  });
});

describe('evaluateCircuitBreakers', () => {
  const nowMs = 1_700_000_000_000;

  it('does nothing to freshly-seeded entries (inside eval window)', () => {
    const key = seedKey('binance-us', 'DOGE-USD');
    const state = {
      entries: {
        [key]: {
          key,
          lastSeededAtMs: nowMs - 60_000, // 1 min ago
          lastSeedCostUsd: 50,
          totalSeedCostUsd: 50,
          pausedUntilMs: 0,
        },
      },
      totalSeedCostUsd: 50,
    };
    const next = evaluateCircuitBreakers(state, { nowMs, realizedProfitByKey: {} });
    expect(next.entries[key].pausedUntilMs).toBe(0);
  });

  it('pauses a seeded pair that missed its earnings target within the eval window', () => {
    const key = seedKey('binance-us', 'DOGE-USD');
    const state = {
      entries: {
        [key]: {
          key,
          lastSeededAtMs: nowMs - (SEED_EVAL_WINDOW_MS + 3_600_000),
          lastSeedCostUsd: 50,
          totalSeedCostUsd: 50,
          pausedUntilMs: 0,
        },
      },
      totalSeedCostUsd: 50,
    };
    // Earned far less than SEED_PROFIT_RATIO × 50 = 75.
    const next = evaluateCircuitBreakers(state, {
      nowMs,
      realizedProfitByKey: { [key]: 1.0 },
    });
    expect(next.entries[key].pausedUntilMs).toBeGreaterThan(nowMs);
    expect(next.entries[key].pausedUntilMs - nowMs).toBeCloseTo(SEED_PAUSE_MS, -3);
    expect(next.entries[key].pauseReason).toBeTruthy();
  });

  it('does NOT pause when earnings met the target', () => {
    const key = seedKey('binance-us', 'DOGE-USD');
    const state = {
      entries: {
        [key]: {
          key,
          lastSeededAtMs: nowMs - (SEED_EVAL_WINDOW_MS + 3_600_000),
          lastSeedCostUsd: 50,
          totalSeedCostUsd: 50,
          pausedUntilMs: 0,
        },
      },
      totalSeedCostUsd: 50,
    };
    const earned = 50 * SEED_PROFIT_RATIO + 0.01;
    const next = evaluateCircuitBreakers(state, {
      nowMs,
      realizedProfitByKey: { [key]: earned },
    });
    expect(next.entries[key].pausedUntilMs).toBe(0);
  });
});

describe('recordSeed', () => {
  it('appends to both per-pair and global totals', () => {
    const key = seedKey('binance-us', 'DOGE-USD');
    const s1 = recordSeed(emptySeedState(), { key, costUsd: 20, nowMs: 1 });
    expect(s1.entries[key].totalSeedCostUsd).toBe(20);
    expect(s1.totalSeedCostUsd).toBe(20);
    const s2 = recordSeed(s1, { key, costUsd: 15, nowMs: 2 });
    expect(s2.entries[key].totalSeedCostUsd).toBe(35);
    expect(s2.totalSeedCostUsd).toBe(35);
    expect(s2.entries[key].lastSeededAtMs).toBe(2);
    expect(s2.entries[key].lastSeedCostUsd).toBe(15);
  });

  it('preserves existing pause state on subsequent records', () => {
    const key = seedKey('binance-us', 'DOGE-USD');
    const seeded = {
      entries: {
        [key]: {
          key,
          lastSeededAtMs: 1,
          lastSeedCostUsd: 10,
          totalSeedCostUsd: 10,
          pausedUntilMs: 999_999,
          pauseReason: 'keep me',
        },
      },
      totalSeedCostUsd: 10,
    };
    const next = recordSeed(seeded, { key, costUsd: 5, nowMs: 50 });
    expect(next.entries[key].pausedUntilMs).toBe(999_999);
    expect(next.entries[key].pauseReason).toBe('keep me');
  });
});

describe('stableBalanceOf / pickStableToSpend — never touches base assets', () => {
  it('sums only USDC/USDT/USD/ZUSD', () => {
    const bal = { USDC: '100', USDT: '50', USD: '10', ZUSD: '5', DOGE: '9999', BTC: '1' };
    expect(stableBalanceOf(bal)).toBe(165);
  });

  it('returns 0 when no stables', () => {
    expect(stableBalanceOf({ DOGE: '1000' })).toBe(0);
  });

  it('picks priority USDC over USDT', () => {
    const pick = pickStableToSpend({ USDC: '50', USDT: '50' }, 20);
    expect(pick?.asset).toBe('USDC');
  });

  it('skips a stable that lacks sufficient balance', () => {
    const pick = pickStableToSpend({ USDC: '5', USDT: '100' }, 20);
    expect(pick?.asset).toBe('USDT');
  });

  it('returns null if no single stable covers the want', () => {
    const pick = pickStableToSpend({ USDC: '5', USDT: '5' }, 20);
    expect(pick).toBeNull();
  });
});

describe('normalizeSeedState', () => {
  it('returns empty state from garbage input', () => {
    expect(normalizeSeedState(null)).toEqual(emptySeedState());
    expect(normalizeSeedState(undefined)).toEqual(emptySeedState());
    expect(normalizeSeedState('nope')).toEqual(emptySeedState());
    expect(normalizeSeedState(42)).toEqual(emptySeedState());
  });

  it('coerces numeric fields and drops malformed entries', () => {
    const state = normalizeSeedState({
      entries: {
        a: { key: 'a', lastSeededAtMs: '100', lastSeedCostUsd: 'nope', totalSeedCostUsd: 5, pausedUntilMs: 0 },
        b: 'garbage',
        c: null,
        d: { /* no key */ lastSeededAtMs: 1 },
      },
      totalSeedCostUsd: '123',
    });
    expect(Object.keys(state.entries)).toEqual(['a']);
    expect(state.entries.a.lastSeededAtMs).toBe(100);
    // NaN-coerced lastSeedCostUsd gets replaced with 0
    expect(state.entries.a.lastSeedCostUsd).toBe(0);
    expect(state.totalSeedCostUsd).toBe(123);
  });
});

describe('SEED_MIN_USD threshold', () => {
  it('refuses a seed smaller than SEED_MIN_USD even if stable covers it', () => {
    // Force size below SEED_MIN_USD by making state nearly at per-pair cap.
    const key = seedKey('binance-us', 'DOGE-USD');
    const state = {
      entries: {
        [key]: {
          key,
          lastSeededAtMs: BASE_INPUT.nowMs - SEED_COOLDOWN_MS - 1,
          lastSeedCostUsd: 1,
          totalSeedCostUsd: SEED_PER_PAIR_USD - (SEED_MIN_USD - 1),
          pausedUntilMs: 0,
        },
      },
      totalSeedCostUsd: SEED_PER_PAIR_USD - (SEED_MIN_USD - 1),
    };
    const d = decideSeed({ ...BASE_INPUT, state });
    expect(d.kind).toBe('seed-too-small');
  });
});
