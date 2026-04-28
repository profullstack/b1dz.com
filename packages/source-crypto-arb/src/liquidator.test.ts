import { describe, it, expect } from 'vitest';
import {
  decideLiquidate,
  recordLiquidation,
  normalizeLiquidatorState,
  emptyLiquidatorState,
  liqKey,
  LIQUIDATE_MAX_SLICE_USD,
  LIQUIDATE_MIN_ASSET_USD,
  LIQUIDATE_COOLDOWN_MS,
  type Holding,
} from './liquidator.js';

type LiquidatorHolding = Holding;

const NOW = 1_700_000_000_000;

function baseInput(overrides: Partial<Parameters<typeof decideLiquidate>[0]> = {}) {
  return {
    exchange: 'binance-us',
    holdings: [] as LiquidatorHolding[],
    stableBalance: 0,
    seedBaseAsset: 'DOGE',
    wantUsd: 15,
    protectedKeys: new Set<string>(),
    nowMs: NOW,
    tradingEnabled: true,
    state: emptyLiquidatorState(),
    ...overrides,
  };
}

describe('decideLiquidate — kill switches', () => {
  it('refuses when trading is off', () => {
    const d = decideLiquidate(baseInput({ tradingEnabled: false }));
    expect(d.kind).toBe('disabled');
  });

  it('short-circuits when stable balance already covers wantUsd', () => {
    const d = decideLiquidate(baseInput({ stableBalance: 50, wantUsd: 15 }));
    expect(d.kind).toBe('already-funded');
  });

  it('respects per-exchange cooldown', () => {
    const state = { lastLiquidatedAtMs: { 'binance-us': NOW - 60_000 } };
    const d = decideLiquidate(baseInput({
      state,
      holdings: [{ asset: 'ADA', amount: 1000, unitPriceUsd: 1 }],
    }));
    expect(d.kind).toBe('cooldown');
    if (d.kind !== 'cooldown') return;
    expect(d.remainingMs).toBeGreaterThan(0);
    expect(d.remainingMs).toBeLessThanOrEqual(LIQUIDATE_COOLDOWN_MS);
  });

  it('allows a fresh liquidation after cooldown expires', () => {
    const state = { lastLiquidatedAtMs: { 'binance-us': NOW - LIQUIDATE_COOLDOWN_MS - 1 } };
    const d = decideLiquidate(baseInput({
      state,
      holdings: [{ asset: 'ADA', amount: 1000, unitPriceUsd: 1 }],
    }));
    expect(d.kind).toBe('liquidate');
  });
});

describe('decideLiquidate — protection of tracked positions', () => {
  it('NEVER sells an asset the trade engine is tracking on this exchange', () => {
    const protectedKeys = new Set([liqKey('binance-us', 'ADA')]);
    const d = decideLiquidate(baseInput({
      holdings: [{ asset: 'ADA', amount: 1000, unitPriceUsd: 1 }],
      protectedKeys,
    }));
    expect(d.kind).toBe('no-candidate');
    if (d.kind !== 'no-candidate') return;
    expect(d.reasons[0]).toEqual({ asset: 'ADA', reason: 'tracked position' });
  });

  it('picks a non-tracked asset over a tracked one of higher value', () => {
    const protectedKeys = new Set([liqKey('binance-us', 'BIG')]);
    const d = decideLiquidate(baseInput({
      holdings: [
        { asset: 'BIG', amount: 100, unitPriceUsd: 100 }, // $10k tracked
        { asset: 'OK', amount: 100, unitPriceUsd: 1 },    // $100 untracked
      ],
      protectedKeys,
    }));
    expect(d.kind).toBe('liquidate');
    if (d.kind !== 'liquidate') return;
    expect(d.asset).toBe('OK');
  });

  it('NEVER sells the seed target asset (would defeat the whole purpose)', () => {
    const d = decideLiquidate(baseInput({
      seedBaseAsset: 'DOGE',
      holdings: [{ asset: 'DOGE', amount: 100, unitPriceUsd: 0.1 }],
    }));
    expect(d.kind).toBe('no-candidate');
    if (d.kind !== 'no-candidate') return;
    expect(d.reasons[0]).toEqual({ asset: 'DOGE', reason: 'same as seed target' });
  });
});

describe('decideLiquidate — dust and size caps', () => {
  it('skips holdings below LIQUIDATE_MIN_ASSET_USD (dust)', () => {
    const d = decideLiquidate(baseInput({
      holdings: [{ asset: 'DUST', amount: 1, unitPriceUsd: 1 }], // $1 < min
    }));
    expect(d.kind).toBe('no-candidate');
  });

  it('never sells more than LIQUIDATE_MAX_SLICE_USD even for a huge bag', () => {
    const d = decideLiquidate(baseInput({
      holdings: [{ asset: 'BIG', amount: 100_000, unitPriceUsd: 1 }],
      wantUsd: 10_000,
    }));
    expect(d.kind).toBe('liquidate');
    if (d.kind !== 'liquidate') return;
    expect(d.expectedUsd).toBeLessThanOrEqual(LIQUIDATE_MAX_SLICE_USD);
  });

  it('never sells more than 50% of any one holding', () => {
    // Need wantUsd high enough that the slice is above LIQUIDATE_MIN_ASSET_USD,
    // but the bag is small enough that 50% becomes the binding cap.
    // $40 bag × 50% = $20, and wantUsd=28 gives target=$29.4 → capped at $20.
    const d = decideLiquidate(baseInput({
      holdings: [{ asset: 'MEDIUM', amount: 40, unitPriceUsd: 1 }], // $40 bag
      wantUsd: 28,
    }));
    expect(d.kind).toBe('liquidate');
    if (d.kind !== 'liquidate') return;
    expect(d.expectedUsd).toBeLessThanOrEqual(20.01);
    expect(d.expectedUsd).toBeGreaterThan(19);
  });

  it('skips a holding whose 50% slice is still below the min threshold', () => {
    // $30 bag × 50% = $15, equal to LIQUIDATE_MIN_ASSET_USD — try slightly smaller
    const d = decideLiquidate(baseInput({
      holdings: [{ asset: 'SMALL', amount: 29, unitPriceUsd: 1 }], // $29 bag, 50% = $14.50
      wantUsd: 20,
    }));
    expect(d.kind).toBe('no-candidate');
    if (d.kind !== 'no-candidate') return;
    expect(d.reasons[0].reason).toContain('slice');
  });
});

describe('decideLiquidate — candidate selection', () => {
  it('prefers the larger bag when multiple untracked candidates exist', () => {
    const d = decideLiquidate(baseInput({
      holdings: [
        { asset: 'SMALL', amount: 20, unitPriceUsd: 1 },   // $20
        { asset: 'LARGE', amount: 1000, unitPriceUsd: 1 }, // $1000
      ],
    }));
    expect(d.kind).toBe('liquidate');
    if (d.kind !== 'liquidate') return;
    expect(d.asset).toBe('LARGE');
  });

  it('skips holdings without a live price (can\'t size the slice safely)', () => {
    const d = decideLiquidate(baseInput({
      holdings: [
        { asset: 'NOQUOTE', amount: 1000, unitPriceUsd: 0 },
        { asset: 'OK', amount: 100, unitPriceUsd: 1 },
      ],
    }));
    expect(d.kind).toBe('liquidate');
    if (d.kind !== 'liquidate') return;
    expect(d.asset).toBe('OK');
  });

  it('uses the current stableBalance to reduce the wantUsd target', () => {
    // Have $5 stables, want $25 → only need $20 more, which is above min.
    const d = decideLiquidate(baseInput({
      stableBalance: 5,
      wantUsd: 25,
      holdings: [{ asset: 'OK', amount: 200, unitPriceUsd: 1 }], // $200 bag
    }));
    expect(d.kind).toBe('liquidate');
    if (d.kind !== 'liquidate') return;
    // Target is (25 - 5) * 1.05 = $21 — above min ($15), below max slice ($30).
    expect(d.expectedUsd).toBeGreaterThan(20);
    expect(d.expectedUsd).toBeLessThan(22);
  });
});

describe('decideLiquidate — limit price buffers for slippage', () => {
  it('sets a slippage-tolerant limit (slightly below mid)', () => {
    const d = decideLiquidate(baseInput({
      holdings: [{ asset: 'OK', amount: 1000, unitPriceUsd: 1.0 }],
    }));
    expect(d.kind).toBe('liquidate');
    if (d.kind !== 'liquidate') return;
    expect(d.limitPriceUsd).toBeLessThan(1.0);
    expect(d.limitPriceUsd).toBeGreaterThan(0.99);
  });
});

describe('recordLiquidation', () => {
  it('stamps the per-exchange timestamp', () => {
    const next = recordLiquidation(emptyLiquidatorState(), { exchange: 'binance-us', nowMs: 123 });
    expect(next.lastLiquidatedAtMs['binance-us']).toBe(123);
  });

  it('does not clobber other exchanges', () => {
    const start = { lastLiquidatedAtMs: { kraken: 100 } };
    const next = recordLiquidation(start, { exchange: 'binance-us', nowMs: 200 });
    expect(next.lastLiquidatedAtMs.kraken).toBe(100);
    expect(next.lastLiquidatedAtMs['binance-us']).toBe(200);
  });
});

describe('normalizeLiquidatorState', () => {
  it('returns empty state for garbage input', () => {
    expect(normalizeLiquidatorState(null)).toEqual(emptyLiquidatorState());
    expect(normalizeLiquidatorState('nope')).toEqual(emptyLiquidatorState());
    expect(normalizeLiquidatorState({})).toEqual(emptyLiquidatorState());
  });

  it('coerces stringified timestamps and drops non-numeric entries', () => {
    const s = normalizeLiquidatorState({
      lastLiquidatedAtMs: { kraken: '100', bogus: 'nope', binance: 200 },
    });
    expect(s.lastLiquidatedAtMs).toEqual({ kraken: 100, binance: 200 });
  });
});
