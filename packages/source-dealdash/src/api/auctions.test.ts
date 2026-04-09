/**
 * Polling layer contract tests. Verifies the URL contracts and the
 * gonzales response normalizer (info Map by auction id, bid balance from
 * `p.bc`).
 */

import { describe, it, expect } from 'vitest';
import { getMyLiveAuctions, getAllLiveAuctions, getAuctionData, getBiddingHistory } from './auctions.js';
import { stubFetcher } from './fetcher.js';

describe('getMyLiveAuctions', () => {
  it('reads feed[0].data', async () => {
    const fetcher = stubFetcher(() => new Response(JSON.stringify({
      feed: [{ data: [101, 102, 103] }],
    }), { status: 200 }));
    expect(await getMyLiveAuctions(fetcher)).toEqual([101, 102, 103]);
  });
  it('returns empty on missing payload', async () => {
    const fetcher = stubFetcher(() => new Response('{}', { status: 200 }));
    expect(await getMyLiveAuctions(fetcher)).toEqual([]);
  });
});

describe('getAllLiveAuctions', () => {
  it('hits the auctions/live endpoint', async () => {
    let path = '';
    const fetcher = stubFetcher((p) => {
      path = p;
      return new Response(JSON.stringify({ feed: [{ data: [1] }] }), { status: 200 });
    });
    await getAllLiveAuctions(fetcher);
    expect(path).toBe('/api/v1/auctionFeed/auctions/live');
  });
});

describe('getAuctionData', () => {
  it('returns details, info map, and bidBalance', async () => {
    const fetcher = stubFetcher((path) => {
      expect(path).toContain('/gonzales.php?idlist=1,2');
      return new Response(JSON.stringify({
        auctionsDetails: [{ auctionId: 1, history: [], timer: 10 }],
        auctions: [
          { i: 1, x: 50, me: 5, bookmarked: false, t: 8, t2: 10 },
          { i: 2, x: 12, me: 0, bookmarked: true,  t: 4, t2: 10 },
        ],
        p: { bc: 942 },
      }), { status: 200 });
    });
    const r = await getAuctionData(fetcher, [1, 2]);
    expect(r.bidBalance).toBe(942);
    expect(r.details).toHaveLength(1);
    expect(r.info.size).toBe(2);
    expect(r.info.get(1)?.x).toBe(50);
    expect(r.info.get(2)?.bookmarked).toBe(true);
  });

  it('short-circuits when ids is empty', async () => {
    let called = false;
    const fetcher = stubFetcher(() => { called = true; return new Response('', { status: 200 }); });
    const r = await getAuctionData(fetcher, []);
    expect(called).toBe(false);
    expect(r.bidBalance).toBe(0);
    expect(r.info.size).toBe(0);
  });
});

describe('getBiddingHistory', () => {
  it('passes the page query param', async () => {
    let path = '';
    const fetcher = stubFetcher((p) => {
      path = p;
      return new Response(JSON.stringify([
        { auctionId: 1, productName: 'x', bidsPlaced: 3, status: 'Won', timestamp: 0 },
      ]), { status: 200 });
    });
    const out = await getBiddingHistory(fetcher, 2);
    expect(path).toContain('?page=2');
    expect(out).toHaveLength(1);
  });
});
