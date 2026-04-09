/**
 * Contract tests for the DealDash strategy / profit math.
 *
 * These tests are the SPEC for the daemon's behavior. Any change here is
 * a deliberate strategy change — the lifted TUI must pass these too once
 * Phase 3 cuts over. Don't change a test to make it pass; if a test
 * fails, the implementation is wrong.
 */

import { describe, it, expect } from 'vitest';
import {
  isPack,
  packSizeFromTitle,
  totalSpent,
  packCostPerBid,
  getResaleValue,
  nonPackEntryFloor,
  projectedProfit,
  profitability,
} from './profit.js';
import { DEFAULT_STRATEGY, type DealDashAuction, type StrategyConfig } from '../types.js';

const cfg: StrategyConfig = { ...DEFAULT_STRATEGY };

const auction = (over: Partial<DealDashAuction> = {}): DealDashAuction => ({
  id: 100,
  title: 'test',
  bidders: 2,
  othersBidding: 1,
  ddPrice: 0,
  bidsBooked: 0,
  bidsSpent: 0,
  totalBids: 0,
  ...over,
});

describe('isPack', () => {
  it('returns true for the Packs category', () => expect(isPack('Packs')).toBe(true));
  it('returns false for everything else', () => {
    expect(isPack('Watches')).toBe(false);
    expect(isPack(undefined)).toBe(false);
    expect(isPack('')).toBe(false);
  });
});

describe('packSizeFromTitle', () => {
  it('parses the canonical "N Bid Pack!" form', () => {
    expect(packSizeFromTitle('850 Bid Pack!')).toBe(850);
    expect(packSizeFromTitle('6000 Bid Pack')).toBe(6000);
  });
  it('parses the prefix "ROYALTY ONLY: ... 9682 Bid Pack!" form', () => {
    expect(packSizeFromTitle('ROYALTY ONLY: Special Blooming Bargains 9682 Bid Pack!')).toBe(9682);
  });
  it('parses the trailing "+ N Bids" pattern from non-pack rewards', () => {
    expect(packSizeFromTitle('Samsung Galaxy + 2200 Bids')).toBe(2200);
  });
  it('returns 0 when no number is present', () => {
    expect(packSizeFromTitle('Some random item')).toBe(0);
    expect(packSizeFromTitle('')).toBe(0);
  });
});

describe('totalSpent', () => {
  it('multiplies bidsSpent by costPerBid and adds the displayed price', () => {
    expect(totalSpent(auction({ bidsSpent: 100, ddPrice: 5 }), cfg))
      .toBeCloseTo(100 * cfg.costPerBid + 5);
  });
  it('handles zero bidsSpent', () => {
    expect(totalSpent(auction({ ddPrice: 0 }), cfg)).toBe(0);
  });
});

describe('packCostPerBid', () => {
  it('returns total spent divided by pack size', () => {
    const a = auction({ title: '850 Bid Pack!', bidsSpent: 47, ddPrice: 9.51 });
    expect(packCostPerBid(a, cfg)).toBeCloseTo((47 * cfg.costPerBid + 9.51) / 850, 4);
  });
  it('returns 0 when title has no parseable size', () => {
    expect(packCostPerBid(auction({ title: 'no number here' }), cfg)).toBe(0);
  });
});

describe('getResaleValue', () => {
  it('uses pack_size × store rate for packs', () => {
    const v = getResaleValue(auction({ title: '850 Bid Pack!' }), null, cfg, true);
    expect(v).toEqual({ value: 850 * cfg.storeBidPrice, source: 'pack' });
  });
  it('returns null for packs with unparseable titles', () => {
    expect(getResaleValue(auction({ title: 'no number' }), null, cfg, true)).toBeNull();
  });
  it('uses market.mean for non-packs when present', () => {
    const v = getResaleValue(auction(), { min: 10, median: 50, mean: 75, count: 5 }, cfg, false);
    expect(v).toEqual({ value: 75, source: 'market' });
  });
  it('falls back to median when mean is missing (nullish coalescing)', () => {
    expect(getResaleValue(auction(), { min: 10, median: 50, count: 5 }, cfg, false))
      .toEqual({ value: 50, source: 'market' });
  });
  it('returns null for non-packs with no market data', () => {
    expect(getResaleValue(auction(), null, cfg, false)).toBeNull();
    expect(getResaleValue(auction(), { min: 0, median: 0, count: 0 }, cfg, false)).toBeNull();
  });
});

describe('nonPackEntryFloor', () => {
  it('returns the base floor when there is exactly one bidder', () => {
    expect(nonPackEntryFloor(1, cfg)).toBe(cfg.nonPackBaseFloor);
  });
  it('adds $50 per extra bidder beyond the first', () => {
    expect(nonPackEntryFloor(2, cfg)).toBe(cfg.nonPackBaseFloor + 50);
    expect(nonPackEntryFloor(3, cfg)).toBe(cfg.nonPackBaseFloor + 100);
    expect(nonPackEntryFloor(5, cfg)).toBe(cfg.nonPackBaseFloor + 200);
  });
  it('clamps zero/negative bidders to no penalty', () => {
    expect(nonPackEntryFloor(0, cfg)).toBe(cfg.nonPackBaseFloor);
    expect(nonPackEntryFloor(-3, cfg)).toBe(cfg.nonPackBaseFloor);
  });
});

describe('profitability', () => {
  it('classifies a fresh huge pack as profit', () => {
    const a = auction({ title: '9682 Bid Pack!', bidsSpent: 5, ddPrice: 1 });
    expect(profitability(a, null, cfg, true, 20)).toBe('profit');
  });
  it('classifies a pack as loss when sunk cost exceeds value − floor', () => {
    // 100 bid pack: value = 100 × 0.15 = $15. With pack floor 20 we need
    // profit ≥ 20 → impossible, always loss.
    const a = auction({ title: '100 Bid Pack!' });
    expect(profitability(a, null, cfg, true, 20)).toBe('loss');
  });
  it('returns unknown for non-pack with no market data', () => {
    expect(profitability(auction(), null, cfg, false, 20)).toBe('unknown');
  });
  it('returns loss for non-pack with empty market results', () => {
    expect(profitability(auction(), { min: 0, median: 0, count: 0 }, cfg, false, 20)).toBe('loss');
  });
  it('returns profit when projected ≥ scaled non-pack floor', () => {
    // bidders=2 → floor=550. Need value − spent ≥ 550.
    const a = auction({ bidsSpent: 0, ddPrice: 0, bidders: 2 });
    expect(profitability(a, { min: 1000, median: 1000, mean: 1000, count: 5 }, cfg, false, 20))
      .toBe('profit');
  });
  it('returns loss when projected < scaled floor', () => {
    const a = auction({ bidsSpent: 0, ddPrice: 0, bidders: 2 });
    expect(profitability(a, { min: 100, median: 100, mean: 100, count: 5 }, cfg, false, 20))
      .toBe('loss');
  });
});

describe('projectedProfit', () => {
  it('subtracts total spent from resale value', () => {
    const a = auction({ title: '6000 Bid Pack!', bidsSpent: 100, ddPrice: 5 });
    const expected = 6000 * cfg.storeBidPrice - (100 * cfg.costPerBid + 5);
    expect(projectedProfit(a, null, cfg, true)).toBeCloseTo(expected, 2);
  });
  it('returns null when value is unknown', () => {
    expect(projectedProfit(auction({ title: 'no size' }), null, cfg, true)).toBeNull();
  });
});
