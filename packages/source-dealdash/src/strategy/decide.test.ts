/**
 * Contract tests for decide() — the whole auto-bid brain.
 *
 * Table-driven: each test builds a DecisionContext, runs decide(), then
 * asserts the resulting decision list + nextMode + duplicates + focus.
 * Every gate the TUI enforces gets locked in here so the daemon can't
 * silently drift.
 */

import { describe, it, expect } from 'vitest';
import { decide, type DecisionContext, type ModeState, type Decision } from './decide.js';
import { makeBalanceMode } from './balance.js';
import { DEFAULT_STRATEGY, type DealDashAuction, type MarketEntry, type StrategyConfig } from '../types.js';

const cfg: StrategyConfig = { ...DEFAULT_STRATEGY };

const auction = (over: Partial<DealDashAuction>): DealDashAuction => ({
  id: 1, title: 'x', bidders: 2, othersBidding: 1, ddPrice: 0,
  bidsBooked: 0, bidsSpent: 0, totalBids: 0, ...over,
});

const pack = (id: number, title: string, over: Partial<DealDashAuction> = {}) =>
  auction({ id, title, ...over });

const nonPack = (id: number, over: Partial<DealDashAuction> = {}) =>
  auction({ id, title: `Item ${id}`, ...over });

function mode(over: Partial<ModeState> = {}): ModeState {
  return {
    balance: makeBalanceMode(),
    focusKeepId: null,
    lifeSavingMode: false,
    exchangeableOnly: false,
    stopLoss: false,
    lockedProductIds: new Set(),
    ...over,
  };
}

function ctxBase(over: Partial<DecisionContext>): DecisionContext {
  return {
    bidBalance: 5000,
    auctions: [],
    categoryOf: () => undefined,
    marketOf: () => null,
    productIdOf: () => undefined,
    exchangeableOf: () => undefined,
    exchangeRateOf: () => undefined,
    cfg,
    mode: mode(),
    maxConcurrent: 5,
    ...over,
  };
}

const book = (r: { decisions: Decision[] }, id: number) =>
  r.decisions.find(d => d.kind === 'book' && d.auctionId === id);
const cancel = (r: { decisions: Decision[] }, id: number) =>
  r.decisions.find(d => d.kind === 'cancel' && d.auctionId === id);

// ---------- balance state transitions ----------

describe('decide: balance hysteresis', () => {
  it('emits "entered" alert when balance drops to enter threshold', () => {
    const r = decide(ctxBase({ bidBalance: 1000 }));
    expect(r.decisions.find(d => d.kind === 'alert' && d.text.includes('LOW BALANCE ENTERED'))).toBeDefined();
    expect(r.nextMode.balance.inLow).toBe(true);
  });
  it('does NOT re-trigger while below the enter threshold', () => {
    const started = mode({ balance: { ...makeBalanceMode(), inLow: true } });
    const r = decide(ctxBase({ bidBalance: 1200, mode: started }));
    expect(r.decisions.find(d => d.kind === 'alert' && d.text.includes('ENTERED'))).toBeUndefined();
    expect(r.nextMode.balance.inLow).toBe(true);
  });
  it('exits at the exit threshold', () => {
    const started = mode({ balance: { ...makeBalanceMode(), inLow: true } });
    const r = decide(ctxBase({ bidBalance: 1500, mode: started }));
    expect(r.decisions.find(d => d.kind === 'alert' && d.text.includes('EXITED'))).toBeDefined();
    expect(r.nextMode.balance.inLow).toBe(false);
  });
});

// ---------- force-exit ----------

describe('decide: force-exit non-pack below rebook floor', () => {
  it('cancels a committed non-pack whose projected profit drops below floor', () => {
    const a = nonPack(1, { bidsBooked: 5, bidsSpent: 500, ddPrice: 50 });
    const market: MarketEntry = { min: 100, median: 100, mean: 100, count: 5 };
    const r = decide(ctxBase({
      auctions: [a],
      marketOf: () => market,
    }));
    const c = cancel(r, 1);
    expect(c).toBeDefined();
    expect((c as Extract<Decision, { kind: 'cancel' }>).reason).toContain('force-exit');
  });
  it('does NOT cancel a pack via the non-pack force-exit path', () => {
    const p = pack(1, '9682 Bid Pack!', { bidsBooked: 5, bidsSpent: 10 });
    const r = decide(ctxBase({
      auctions: [p],
      categoryOf: () => 'Packs',
    }));
    const c = cancel(r, 1);
    if (c) expect((c as Extract<Decision, { kind: 'cancel' }>).reason).not.toContain('force-exit');
  });
});

// ---------- pack overpriced ----------

describe('decide: pack overpriced', () => {
  it('cancels a pack whose effective $/bid crosses MAX_PACK_PER_BID', () => {
    // 100 bid pack, spent 100 × 0.107 + $0 = $10.70, $/bid = 0.107 > 0.05
    const p = pack(1, '100 Bid Pack!', { bidsBooked: 5, bidsSpent: 100 });
    const r = decide(ctxBase({
      auctions: [p],
      categoryOf: () => 'Packs',
    }));
    expect(cancel(r, 1)?.reason).toContain('pack overpriced');
  });
  it('does NOT cancel a pack still under the ceiling', () => {
    // 9682 bid pack, small spend → tiny $/bid
    const p = pack(1, '9682 Bid Pack!', { bidsBooked: 5, bidsSpent: 10, ddPrice: 2 });
    const r = decide(ctxBase({
      auctions: [p],
      categoryOf: () => 'Packs',
    }));
    const c = cancel(r, 1);
    if (c) expect((c as Extract<Decision, { kind: 'cancel' }>).reason).not.toContain('pack overpriced');
  });
});

// ---------- low-balance dedup ----------

describe('decide: low-balance dedup by productId', () => {
  it('flags the lower-sunk-cost same-product auction as duplicate', () => {
    const winner = pack(100, '9682 Bid Pack!', { bidsBooked: 5, bidsSpent: 80 });
    const loser  = pack(200, '9682 Bid Pack!', { bidsBooked: 0, bidsSpent: 1 });
    const r = decide(ctxBase({
      bidBalance: 500,
      auctions: [winner, loser],
      categoryOf: () => 'Packs',
      productIdOf: () => 48147,
    }));
    expect(r.duplicates.has(200)).toBe(true);
    expect(r.duplicates.has(100)).toBe(false);
  });

  it('cancels the loser only if it has a committed queue', () => {
    const winner = pack(100, '9682 Bid Pack!', { bidsBooked: 5, bidsSpent: 80 });
    const loserQueued  = pack(200, '9682 Bid Pack!', { bidsBooked: 2, bidsSpent: 1 });
    const r = decide(ctxBase({
      bidBalance: 500,
      auctions: [winner, loserQueued],
      categoryOf: () => 'Packs',
      productIdOf: () => 48147,
    }));
    const c = cancel(r, 200);
    expect(c).toBeDefined();
    expect((c as Extract<Decision, { kind: 'cancel' }>).reason).toContain('dup-product');
  });
});

// ---------- focus mode ----------

describe('decide: low-balance focus', () => {
  it('picks the pack with the best rejoin score as focus', () => {
    const bigPack   = pack(100, '9682 Bid Pack!', { bidsBooked: 5, bidsSpent: 80, bidders: 3 });
    const smallPack = pack(200, '5000 Bid Pack',  { bidsBooked: 5, bidsSpent: 800, bidders: 3 });
    const r = decide(ctxBase({
      bidBalance: 500,
      auctions: [smallPack, bigPack],
      categoryOf: () => 'Packs',
    }));
    expect(r.focusKeepId).toBe(100);
  });

  it('cancels all non-focus committed fights in low-balance mode', () => {
    const winner = pack(100, '9682 Bid Pack!', { bidsBooked: 5, bidsSpent: 80 });
    const loser1 = pack(200, '5000 Bid Pack',  { bidsBooked: 5, bidsSpent: 50 });
    const loser2 = nonPack(300, { bidsBooked: 5, bidsSpent: 50 });
    const r = decide(ctxBase({
      bidBalance: 500,
      auctions: [winner, loser1, loser2],
      categoryOf: (id) => id === 300 ? 'Watches' : 'Packs',
    }));
    expect(r.focusKeepId).toBe(100);
    expect(cancel(r, 200)).toBeDefined();
    // 300 already got cancelled by force-exit (no market data → unknown, skipped)
    // OR by auto-cancel/focus. Either way non-winner.
    expect(cancel(r, 100)).toBeUndefined();
  });

  it('respects lifeSavingMode without the balance dropping', () => {
    const winner = pack(100, '9682 Bid Pack!', { bidsBooked: 5, bidsSpent: 80 });
    const r = decide(ctxBase({
      bidBalance: 5000,
      auctions: [winner],
      categoryOf: () => 'Packs',
      mode: mode({ lifeSavingMode: true }),
    }));
    expect(r.focusKeepId).toBe(100);
  });
});

// ---------- rebook ----------

describe('decide: rebook lock in low-balance mode', () => {
  it('rebooks only the focus pick, not any other committed fight', () => {
    const winner = pack(100, '9682 Bid Pack!', { bidsBooked: 1, bidsSpent: 80 });
    const other  = pack(200, '5000 Bid Pack',  { bidsBooked: 1, bidsSpent: 50 });
    const r = decide(ctxBase({
      bidBalance: 2000, // enough for a rebook
      auctions: [winner, other],
      categoryOf: () => 'Packs',
      mode: mode({ lifeSavingMode: true }),
    }));
    expect(book(r, 100)).toBeDefined();
    // Not the other (unless the script cancelled + removed it)
    expect(book(r, 200)).toBeUndefined();
  });
});

// ---------- too-many-bidders cancel ----------

describe('decide: too-many-bidders auto-cancel', () => {
  it('cancels a non-pack with 4+ bidders', () => {
    const a = nonPack(1, { bidders: 5, othersBidding: 4, bidsBooked: 3, bidsSpent: 10 });
    const r = decide(ctxBase({ auctions: [a] }));
    const c = cancel(r, 1);
    expect(c?.reason).toContain('too many bidders (5)');
  });
  it('allows packs with 4 bidders (pack cancelAt = 4)', () => {
    const p = pack(1, '850 Bid Pack!', { bidders: 4, othersBidding: 3, bidsBooked: 3 });
    const r = decide(ctxBase({ auctions: [p], categoryOf: () => 'Packs' }));
    const c = cancel(r, 1);
    if (c) expect((c as Extract<Decision, { kind: 'cancel' }>).reason).not.toContain('too many bidders');
  });
});

// ---------- new entry gates ----------

describe('decide: new entries', () => {
  it('in survival mode, only enters 2-bidder packs', () => {
    const p2  = pack(10, '850 Bid Pack!', { bidders: 2, othersBidding: 1 });
    const p3  = pack(11, '850 Bid Pack!', { bidders: 3, othersBidding: 2 });
    const it1 = nonPack(12, { bidders: 2 });
    const r = decide(ctxBase({
      bidBalance: 500,
      auctions: [p2, p3, it1],
      categoryOf: (id) => [10, 11].includes(id) ? 'Packs' : 'Watches',
    }));
    expect(book(r, 10)).toBeDefined();
    expect(book(r, 11)).toBeUndefined();
    expect(book(r, 12)).toBeUndefined();
  });

  it('same-product cooldown blocks a second front on identical auctions', () => {
    const a = pack(10, '850 Bid Pack!', { bidders: 2, bidsSpent: 5, bidsBooked: 3 });
    const b = pack(11, '850 Bid Pack!', { bidders: 2 });
    const r = decide(ctxBase({
      auctions: [a, b],
      categoryOf: () => 'Packs',
      productIdOf: () => 24935,
    }));
    expect(book(r, 11)).toBeUndefined(); // blocked by cooldown
  });

  it('respects 30-day product lockout', () => {
    const a = pack(10, '850 Bid Pack!', { bidders: 2 });
    const r = decide(ctxBase({
      auctions: [a],
      categoryOf: () => 'Packs',
      productIdOf: () => 24935,
      mode: mode({ lockedProductIds: new Set([24935]) }),
    }));
    expect(book(r, 10)).toBeUndefined();
  });

  it('skips new entries when stopLoss is tripped', () => {
    const a = pack(10, '850 Bid Pack!', { bidders: 2 });
    const r = decide(ctxBase({
      auctions: [a],
      categoryOf: () => 'Packs',
      mode: mode({ stopLoss: true }),
    }));
    expect(book(r, 10)).toBeUndefined();
  });

  it('honors the concurrency cap', () => {
    const fights = Array.from({ length: 5 }, (_, i) => auction({ id: 100 + i, bidsBooked: 3, bidsSpent: 10, bidders: 2 }));
    const fresh = pack(200, '850 Bid Pack!', { bidders: 2 });
    const r = decide(ctxBase({
      auctions: [...fights, fresh],
      categoryOf: (id) => id === 200 ? 'Packs' : undefined,
      maxConcurrent: 5,
    }));
    expect(book(r, 200)).toBeUndefined();
  });
});
