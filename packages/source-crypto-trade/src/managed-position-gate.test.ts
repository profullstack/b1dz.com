/**
 * Unit tests for the "managed vs restored position" distinction used
 * by the entry gate.
 *
 * Production symptom: a user with $30 spendable USD on Coinbase + a
 * passive DASH wallet holding (synthesized as a Position by the
 * cold-start hydrator with entryPrice == currentBid) saw zero new
 * Coinbase trades for hours. The "one position per exchange" rule
 * was treating the leftover wallet inventory as a real bot position
 * and locking the venue out of fresh entries forever. Same story for
 * Kraken/Binance with any leftover non-stable asset.
 *
 * The fix introduces `restoredFromHydration: true` on positions
 * synthesized by the hydrator, and a dedicated
 * `hasManagedPositionOnExchange` predicate that the entry gate uses.
 * These tests lock in that behavior so a future refactor doesn't
 * silently regress it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetTradeStateForTests,
  __seedOpenPositionForTests,
  __getOpenPositionForTests,
  __hasManagedPositionOnExchangeForTests,
  serializeTradeState,
  restorePersistedTradeState,
} from './index.js';

afterEach(() => {
  __resetTradeStateForTests();
});

describe('hasManagedPositionOnExchange', () => {
  it('returns false when only restored hydration positions exist', () => {
    __seedOpenPositionForTests({
      pair: 'DASH-USD',
      exchange: 'coinbase',
      entryPrice: 55.88,
      volume: 0.52,
      entryTime: Date.now() - 60 * 60_000,
      highWaterMark: 55.88,
      entryFee: 0,
      priceSamples: [],
      restoredFromHydration: true,
    });
    expect(__hasManagedPositionOnExchangeForTests('coinbase')).toBe(false);
  });

  it('returns true when a managed (real-buy) position exists', () => {
    __seedOpenPositionForTests({
      pair: 'BTC-USD',
      exchange: 'kraken',
      entryPrice: 80_000,
      volume: 0.001,
      entryTime: Date.now() - 5 * 60_000,
      highWaterMark: 80_500,
      strategyId: 'momentum',
      entryFee: 0.21,
      priceSamples: [80_000, 80_300, 80_500],
      // restoredFromHydration intentionally undefined — this is what a
      // freshly-opened bot position looks like.
    });
    expect(__hasManagedPositionOnExchangeForTests('kraken')).toBe(true);
  });

  it('only blocks the venue when at least one managed position exists', () => {
    // Two positions on Coinbase: one restored, one managed.
    __seedOpenPositionForTests({
      pair: 'DASH-USD',
      exchange: 'coinbase',
      entryPrice: 55.88,
      volume: 0.52,
      entryTime: Date.now() - 60 * 60_000,
      highWaterMark: 55.88,
      entryFee: 0,
      priceSamples: [],
      restoredFromHydration: true,
    });
    __seedOpenPositionForTests({
      pair: 'BTC-USD',
      exchange: 'coinbase',
      entryPrice: 82_000,
      volume: 0.0001,
      entryTime: Date.now() - 60_000,
      highWaterMark: 82_400,
      strategyId: 'momentum',
      entryFee: 0.05,
      priceSamples: [82_000, 82_400],
    });
    expect(__hasManagedPositionOnExchangeForTests('coinbase')).toBe(true);
  });

  it('does NOT count restored positions on a different exchange', () => {
    __seedOpenPositionForTests({
      pair: 'DASH-USD',
      exchange: 'coinbase',
      entryPrice: 55.88,
      volume: 0.52,
      entryTime: Date.now(),
      highWaterMark: 55.88,
      entryFee: 0,
      priceSamples: [],
      restoredFromHydration: true,
    });
    expect(__hasManagedPositionOnExchangeForTests('kraken')).toBe(false);
    expect(__hasManagedPositionOnExchangeForTests('binance-us')).toBe(false);
    expect(__hasManagedPositionOnExchangeForTests('gemini')).toBe(false);
  });
});

describe('restoredFromHydration round-trips through persisted state', () => {
  it('preserves the flag across serializeTradeState → restorePersistedTradeState', () => {
    __seedOpenPositionForTests({
      pair: 'DASH-USD',
      exchange: 'coinbase',
      entryPrice: 55.88,
      volume: 0.52,
      entryTime: 1_700_000_000_000,
      highWaterMark: 55.88,
      entryFee: 0,
      priceSamples: [],
      restoredFromHydration: true,
    });
    __seedOpenPositionForTests({
      pair: 'BTC-USD',
      exchange: 'kraken',
      entryPrice: 80_000,
      volume: 0.001,
      entryTime: 1_700_000_005_000,
      highWaterMark: 80_500,
      entryFee: 0.21,
      priceSamples: [80_000, 80_500],
      // managed position — flag absent
    });

    const serialized = serializeTradeState();

    // Reset module state and replay.
    __resetTradeStateForTests();
    restorePersistedTradeState({ tradeState: serialized });

    const dash = __getOpenPositionForTests('coinbase', 'DASH-USD');
    const btc = __getOpenPositionForTests('kraken', 'BTC-USD');
    expect(dash).not.toBeNull();
    expect(btc).not.toBeNull();
    expect(dash!.restoredFromHydration).toBe(true);
    expect(btc!.restoredFromHydration).toBe(false); // normalized: undefined → false on restore
  });

  it('treats absent flag in legacy persisted state as managed (false)', () => {
    // Simulate a payload written before the flag existed.
    const legacy = {
      tradeState: {
        positions: [{
          pair: 'BTC-USD',
          exchange: 'kraken',
          entryPrice: 80_000,
          volume: 0.001,
          entryTime: 1_700_000_005_000,
          highWaterMark: 80_500,
          entryFee: 0.21,
          priceSamples: [80_000, 80_500],
          // no restoredFromHydration field
        }],
        exits: [],
      },
    };
    restorePersistedTradeState(legacy);

    // Legacy payloads predate hydration tagging — we treat them as
    // managed (the safer default: a real BTC entry shouldn't suddenly
    // be classified as passively-held).
    expect(__hasManagedPositionOnExchangeForTests('kraken')).toBe(true);
  });
});
