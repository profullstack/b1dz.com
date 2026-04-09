/**
 * Contract tests for toDisplayAuctions — the projection from raw DealDash
 * API responses into the typed DealDashAuction the strategy consumes.
 *
 * Bidder counts come from the history array (distinct usernames). The
 * "am I in this fight" signal is `me > 0` from gonzales OR "my username
 * appears in the visible history" — either adds us to the count.
 */

import { describe, it, expect } from 'vitest';
import { toDisplayAuctions } from './project.js';
import type { AuctionDetail, AuctionInfo } from './api/auctions.js';

const info = (over: Partial<AuctionInfo> & Pick<AuctionInfo, 'i'>): AuctionInfo => ({
  x: 0, me: 0, bookmarked: false, ...over,
});

const mkHistory = (...users: string[]): AuctionDetail['history'] =>
  users.map((u, i) => [`${i + 1}.00`, 1_700_000_000 + i, u] as [string, number, string]);

const detail = (id: number, hist: AuctionDetail['history']): AuctionDetail =>
  ({ auctionId: id, history: hist, timer: 10 });

describe('toDisplayAuctions', () => {
  it('counts distinct bidders from history', () => {
    const out = toDisplayAuctions({
      details: [detail(1, mkHistory('alice', 'bob', 'alice', 'carol'))],
      info: new Map([[1, info({ i: 1, x: 10, r: '2.50', bb: { a: 5, c: 3 } })]]),
      titles: { 1: 'Some Item' },
      bidsSpent: { 1: 7 },
      username: '',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 1, title: 'Some Item', bidders: 3, othersBidding: 3,
      ddPrice: 2.5, bidsBooked: 3, bidsSpent: 7, totalBids: 10,
    });
  });

  it('adds us to the bidder count when we are in (via me > 0) but not yet in history', () => {
    const out = toDisplayAuctions({
      details: [detail(1, mkHistory('alice', 'bob'))],
      info: new Map([[1, info({ i: 1, x: 10, me: 3, r: '2.50' })]]),
      titles: { 1: 'x' },
      bidsSpent: {},
      username: 'chovy',
    });
    // alice + bob = 2 from history, +1 for us (me>0 and not in history) = 3
    expect(out[0].bidders).toBe(3);
    expect(out[0].othersBidding).toBe(2);
  });

  it('does NOT double-count us when we appear in both me>0 AND history', () => {
    const out = toDisplayAuctions({
      details: [detail(1, mkHistory('alice', 'chovy', 'bob'))],
      info: new Map([[1, info({ i: 1, x: 10, me: 3, r: '2.50' })]]),
      titles: { 1: 'x' },
      bidsSpent: {},
      username: 'chovy',
    });
    expect(out[0].bidders).toBe(3); // alice, chovy, bob — not 4
    expect(out[0].othersBidding).toBe(2);
  });

  it('reports othersBidding = bidders when we are NOT in the fight', () => {
    const out = toDisplayAuctions({
      details: [detail(1, mkHistory('alice', 'bob'))],
      info: new Map([[1, info({ i: 1, x: 10, me: 0 })]]),
      titles: {},
      bidsSpent: {},
      username: 'chovy',
    });
    expect(out[0].bidders).toBe(2);
    expect(out[0].othersBidding).toBe(2);
  });

  it('falls back to 1 bidder when x > 0 but history is empty', () => {
    // Fresh auction: gonzales has x=1 but the history hasn't been pulled yet
    const out = toDisplayAuctions({
      details: [detail(1, [])],
      info: new Map([[1, info({ i: 1, x: 1 })]]),
      titles: {},
      bidsSpent: {},
      username: 'chovy',
    });
    expect(out[0].bidders).toBe(1);
  });

  it('reports 0 bidders when nothing has happened yet', () => {
    const out = toDisplayAuctions({
      details: [detail(1, [])],
      info: new Map([[1, info({ i: 1, x: 0 })]]),
      titles: {},
      bidsSpent: {},
      username: 'chovy',
    });
    expect(out[0].bidders).toBe(0);
  });

  it('handles auctions in info without a matching detail', () => {
    const out = toDisplayAuctions({
      details: [],
      info: new Map([[1, info({ i: 1, x: 5 })]]),
      titles: { 1: 'orphan' },
      bidsSpent: {},
      username: '',
    });
    expect(out[0].bidders).toBe(1); // x>0 so floor at 1
  });

  it('pulls bidsSpent from the cache', () => {
    const out = toDisplayAuctions({
      details: [detail(1, [])],
      info: new Map([[1, info({ i: 1, x: 0 })]]),
      titles: {},
      bidsSpent: { 1: 42 },
      username: '',
    });
    expect(out[0].bidsSpent).toBe(42);
  });
});
