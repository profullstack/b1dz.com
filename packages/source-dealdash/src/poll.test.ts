/**
 * Contract tests for pollOnce. The whole point is that pollOnce is
 * deterministic given (fetcher, storage, now): stub all three and verify
 * every output field + persisted state transition.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { pollOnce, type PollContext, type DealDashSourceState } from './poll.js';
import { stubFetcher } from './api/fetcher.js';
import type { Storage } from '@b1dz/core';

// ---------- tiny in-memory storage ----------

class MemStorage implements Storage {
  private data = new Map<string, unknown>();
  private k(c: string, k: string) { return `${c}:${k}`; }
  async get<T>(c: string, k: string) { return (this.data.get(this.k(c, k)) ?? null) as T | null; }
  async put<T>(c: string, k: string, v: T) { this.data.set(this.k(c, k), v); }
  async delete(c: string, k: string) { this.data.delete(this.k(c, k)); }
  async list<T>(c: string) {
    const prefix = `${c}:`;
    return [...this.data.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v as T);
  }
  async query<T>(c: string, pred: (v: T) => boolean) { return (await this.list<T>(c)).filter(pred); }
}

// ---------- canned DealDash responses ----------

const MY_LIVE_RESPONSE = {
  feed: [{ data: [16345729, 16342488] }],
};

const ALL_LIVE_RESPONSE = {
  feed: [{ data: [16345729, 16342488, 16345000, 16345100] }],
};

const GONZALES_RESPONSE = {
  auctionsDetails: [
    { auctionId: 16345729, history: [], timer: 10 },
    { auctionId: 16342488, history: [], timer: 10 },
  ],
  auctions: [
    { i: 16345729, x: 82, me: 5, bookmarked: true, t: 8, t2: 10 },
    { i: 16342488, x: 884, me: 19, bookmarked: false, t: 4, t2: 10 },
    { i: 16345000, x: 10, me: 0, bookmarked: false, t: 6, t2: 10 },
    { i: 16345100, x: 20, me: 0, bookmarked: false, t: 7, t2: 10 },
  ],
  p: { bc: 942 },
};

const ORDERS_RESPONSE = {
  data: [
    {
      type: 'Auction win', title: 'Bose', auctionId: '16342411',
      price: 0.25, timestamp: 1775637000, ffid: 'A44847767',
    },
  ],
};

const HISTORY_RESPONSE = [
  { auctionId: 16345729, productName: 'ROYALTY ONLY: ... 9682 Bid Pack!', bidsPlaced: 82, status: 'Ongoing', timestamp: 0 },
  { auctionId: 16342488, productName: '5000 Bid Pack',                    bidsPlaced: 884, status: 'Ongoing', timestamp: 0 },
];

const HTML_FOR_16345729 = `
  dd.auctionFeed = {"auctions":{"static":{"16345729":{"id":16345729,"name":"ROYALTY ONLY: Special Blooming Bargains 9682 Bid Pack!","categoryName":"Packs","buyItNowPrice":1355,"exchangeable":false,"productId":48147,"noReEntry":false}}}};
`;
const HTML_FOR_16342488 = `
  dd.auctionFeed = {"auctions":{"static":{"16342488":{"id":16342488,"name":"5000 Bid Pack","categoryName":"Packs","buyItNowPrice":700,"exchangeable":false,"productId":33281,"noReEntry":false}}}};
`;

function makeRouter() {
  return (path: string) => {
    if (path.includes('/api/v1/auctionFeed/my-auctions/live')) return new Response(JSON.stringify(MY_LIVE_RESPONSE), { status: 200 });
    if (path.includes('/api/v1/auctionFeed/auctions/live')) return new Response(JSON.stringify(ALL_LIVE_RESPONSE), { status: 200 });
    if (path.includes('/gonzales.php')) return new Response(JSON.stringify(GONZALES_RESPONSE), { status: 200 });
    if (path.includes('/api/v2/orders/my-orders-data')) return new Response(JSON.stringify(ORDERS_RESPONSE), { status: 200 });
    if (path.includes('/api/v1/users/me/bidding-history')) return new Response(JSON.stringify(HISTORY_RESPONSE), { status: 200 });
    if (path === '/auction/16345729') return new Response(HTML_FOR_16345729, { status: 200 });
    if (path === '/auction/16342488') return new Response(HTML_FOR_16342488, { status: 200 });
    if (path === '/auction/16342411') return new Response('', { status: 404 });
    return new Response('not stubbed: ' + path, { status: 500 });
  };
}

function makeCtx(overrides: Partial<PollContext> = {}): PollContext {
  return {
    userId: 'test-user',
    fetcher: stubFetcher(makeRouter()),
    storage: new MemStorage(),
    now: () => 1_700_000_000_000,
    pageInfoBudget: 10,
    ...overrides,
  };
}

// ---------- tests ----------

describe('pollOnce', () => {
  let ctx: PollContext;
  beforeEach(() => { ctx = makeCtx(); });

  it('returns the bid balance from the gonzales response', async () => {
    const r = await pollOnce(ctx);
    expect(r.bidBalance).toBe(942);
  });

  it('returns my live auction ids', async () => {
    const r = await pollOnce(ctx);
    expect(r.myIds).toEqual([16345729, 16342488]);
  });

  it('returns the full live feed ids', async () => {
    const r = await pollOnce(ctx);
    expect(r.allIds).toEqual([16345729, 16342488, 16345000, 16345100]);
  });

  it('populates the info map keyed by auction id', async () => {
    const r = await pollOnce(ctx);
    expect(r.info.get(16345729)?.x).toBe(82);
    expect(r.info.get(16342488)?.me).toBe(19);
  });

  it('normalizes wins from the orders feed', async () => {
    const r = await pollOnce(ctx);
    expect(r.wins).toHaveLength(1);
    expect(r.wins[0]).toMatchObject({ id: 16342411, orderId: '44847767', exchanged: false });
  });

  it('seeds caches from history.bidsPlaced authoritatively', async () => {
    const r = await pollOnce(ctx);
    expect(r.caches.bidsSpent[16345729]).toBe(82);
    expect(r.caches.bidsSpent[16342488]).toBe(884);
  });

  it('scrapes page info + populates title/category/bin/product caches', async () => {
    const r = await pollOnce(ctx);
    expect(r.caches.titles[16345729]).toContain('9682 Bid Pack');
    expect(r.caches.categories[16345729]).toBe('Packs');
    expect(r.caches.bin[16345729]).toBe(1355);
    expect(r.caches.productIds[16345729]).toBe(48147);
    expect(r.caches.titles[16342488]).toBe('5000 Bid Pack');
  });

  it('persists updated caches to source_state via the Storage adapter', async () => {
    await pollOnce(ctx);
    const saved = await ctx.storage.get<DealDashSourceState>('source-state', 'dealdash');
    expect(saved?.caches?.titles?.[16345729]).toContain('9682');
    expect(saved?.caches?.bidsSpent?.[16345729]).toBe(82);
  });

  it('hydrates existing cache data and does NOT re-scrape already-cached auctions', async () => {
    await ctx.storage.put<DealDashSourceState>('source-state', 'dealdash', {
      caches: {
        titles: { 16345729: 'cached title' },
        categories: { 16345729: 'Packs' },
      },
    });
    // Fail the scrape route so we can prove we didn't call it
    ctx = makeCtx({
      storage: ctx.storage,
      fetcher: stubFetcher((path) => {
        if (path === '/auction/16345729') throw new Error('should not scrape cached auction');
        return makeRouter()(path);
      }),
    });
    const r = await pollOnce(ctx);
    // 16342488 still gets scraped, 16345729 does not
    expect(r.newPageInfo.has(16345729)).toBe(false);
    expect(r.newPageInfo.has(16342488)).toBe(true);
    // Pre-existing cached title is preserved
    expect(r.caches.titles[16345729]).toBe('cached title');
  });

  it('respects pageInfoBudget (no more than N page scrapes per tick)', async () => {
    let scrapeCount = 0;
    ctx = makeCtx({
      pageInfoBudget: 1,
      fetcher: stubFetcher((path) => {
        if (path.startsWith('/auction/')) scrapeCount++;
        return makeRouter()(path);
      }),
    });
    await pollOnce(ctx);
    expect(scrapeCount).toBe(1);
  });

  it('preserves other source_state fields (like credentials)', async () => {
    await ctx.storage.put<DealDashSourceState & { credentials: unknown }>('source-state', 'dealdash', {
      credentials: { phpsessid: 'xxx', rememberme: 'yyy' },
    });
    await pollOnce(ctx);
    const saved = await ctx.storage.get<DealDashSourceState & { credentials: unknown }>('source-state', 'dealdash');
    expect(saved?.credentials).toEqual({ phpsessid: 'xxx', rememberme: 'yyy' });
    expect(saved?.caches?.titles?.[16345729]).toBeDefined(); // and still wrote the new caches
  });
});
