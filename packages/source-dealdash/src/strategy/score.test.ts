/**
 * Contract tests for rejoin scoring + sort. Lock in the focus picker's
 * decision so we can refactor with confidence.
 */

import { describe, it, expect } from 'vitest';
import { rejoinScore, compareRejoin } from './score.js';
import { DEFAULT_STRATEGY, type DealDashAuction, type MarketEntry, type StrategyConfig } from '../types.js';

const cfg: StrategyConfig = { ...DEFAULT_STRATEGY };

const auction = (over: Partial<DealDashAuction>): DealDashAuction => ({
  id: 1, title: 'x', bidders: 2, othersBidding: 1, ddPrice: 0,
  bidsBooked: 0, bidsSpent: 0, totalBids: 0, ...over,
});

describe('rejoinScore', () => {
  it('packs use total upside / sqrt(bidders)', () => {
    const a = auction({ title: '9682 Bid Pack!', bidsSpent: 82, ddPrice: 18.20, bidders: 5 });
    const r = rejoinScore(a, null, cfg, true);
    expect(r.pack).toBe(true);
    // upside = (0.15 - 26.97/9682) * 9682 ≈ 1424.47
    // score  = 1424.47 / sqrt(5) ≈ 637
    expect(r.upside).toBeGreaterThan(1400);
    expect(r.upside).toBeLessThan(1450);
    expect(r.score).toBeGreaterThan(600);
    expect(r.score).toBeLessThan(650);
  });

  it('non-packs use projected profit / sqrt(bidders)', () => {
    const a = auction({ bidsSpent: 0, ddPrice: 0, bidders: 4 });
    const m: MarketEntry = { min: 100, median: 200, mean: 300, count: 10 };
    const r = rejoinScore(a, m, cfg, false);
    expect(r.pack).toBe(false);
    expect(r.upside).toBe(300);
    expect(r.score).toBeCloseTo(300 / 2, 2);
  });

  it('higher bidder count lowers the score (sqrt penalty)', () => {
    const a2 = auction({ title: '9682 Bid Pack!', bidders: 2 });
    const a5 = auction({ title: '9682 Bid Pack!', bidders: 5 });
    const r2 = rejoinScore(a2, null, cfg, true);
    const r5 = rejoinScore(a5, null, cfg, true);
    expect(r2.score).toBeGreaterThan(r5.score);
  });

  it('larger packs at the same bidder count score higher', () => {
    const big   = auction({ title: '9682 Bid Pack!', bidders: 3 });
    const small = auction({ title: '375 Bid Pack!',  bidders: 3 });
    expect(rejoinScore(big, null, cfg, true).score)
      .toBeGreaterThan(rejoinScore(small, null, cfg, true).score);
  });
});

describe('compareRejoin (sort)', () => {
  const market = (): MarketEntry => ({ min: 100, median: 100, mean: 100, count: 5 });

  it('always puts packs ahead of non-packs', () => {
    const pack = auction({ id: 1, title: '6000 Bid Pack!', bidders: 5 });
    const item = auction({ id: 2, bidders: 2 });
    const list = [item, pack].sort((a, b) => compareRejoin(
      a, b, () => market(), cfg,
      x => x.title.toLowerCase().includes('bid pack'),
    ));
    expect(list[0].id).toBe(1); // pack first
  });

  it('within packs, higher score wins', () => {
    const big   = auction({ id: 1, title: '9682 Bid Pack!', bidsSpent: 82, ddPrice: 18, bidders: 5 });
    const small = auction({ id: 2, title: '5000 Bid Pack',   bidsSpent: 884, ddPrice: 49, bidders: 3 });
    const list = [small, big].sort((a, b) => compareRejoin(
      a, b, () => null, cfg,
      () => true,
    ));
    expect(list[0].id).toBe(1); // 9682 pack ranks above 5000 pack despite more bidders
  });
});
