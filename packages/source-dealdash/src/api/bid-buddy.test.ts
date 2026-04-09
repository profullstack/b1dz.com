/**
 * Action contract tests. Each mutation goes through a stub fetcher so we
 * can verify the URL, method, and body shape without hitting DealDash.
 */

import { describe, it, expect } from 'vitest';
import { bookBid, cancelBidBuddy, exchangeWinForBids } from './bid-buddy.js';
import { stubFetcher } from './fetcher.js';

describe('bookBid', () => {
  it('POSTs to /api/v1/auction/:id/bidBuddy with the count', async () => {
    let captured: { path: string; init: RequestInit } | null = null;
    const fetcher = stubFetcher((path, init) => {
      captured = { path, init };
      return new Response('{}', { status: 200 });
    });
    const r = await bookBid(fetcher, 123, 5);
    expect(r).toEqual({ ok: true });
    expect(captured!.path).toBe('/api/v1/auction/123/bidBuddy');
    expect(captured!.init.method).toBe('POST');
    expect(JSON.parse(captured!.init.body as string)).toEqual({ count: 5 });
  });

  it('clamps count to at least 1', async () => {
    let body: unknown;
    const fetcher = stubFetcher((_, init) => {
      body = JSON.parse(init.body as string);
      return new Response('', { status: 200 });
    });
    await bookBid(fetcher, 1, 0);
    expect(body).toEqual({ count: 1 });
    await bookBid(fetcher, 1, -5);
    expect(body).toEqual({ count: 1 });
  });

  it('returns ok:false with status + body on a non-2xx', async () => {
    const fetcher = stubFetcher(() => new Response('rate limited', { status: 429 }));
    const r = await bookBid(fetcher, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(429);
      expect(r.error).toContain('rate limited');
    }
  });
});

describe('cancelBidBuddy', () => {
  it('DELETEs the bidBuddy resource', async () => {
    let captured: { path: string; init: RequestInit } | null = null;
    const fetcher = stubFetcher((path, init) => {
      captured = { path, init };
      return new Response('', { status: 200 });
    });
    const r = await cancelBidBuddy(fetcher, 16345729);
    expect(r).toEqual({ ok: true });
    expect(captured!.path).toBe('/api/v1/auction/16345729/bidBuddy');
    expect(captured!.init.method).toBe('DELETE');
  });
});

describe('exchangeWinForBids', () => {
  it('POSTs order_id to wonAuctionExchangeBids with referer headers', async () => {
    let captured: { path: string; init: RequestInit } | null = null;
    const fetcher = stubFetcher((path, init) => {
      captured = { path, init };
      return new Response('', { status: 200 });
    });
    await exchangeWinForBids(fetcher, 16342587, '44848363');
    expect(captured!.path).toBe('/api/v1/auction/16342587/wonAuctionExchangeBids');
    expect(captured!.init.method).toBe('POST');
    expect(JSON.parse(captured!.init.body as string)).toEqual({ order_id: '44848363' });
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Referer).toContain('16342587/win-payment');
  });

  it('returns the server error message on 4xx (e.g. already exchanged)', async () => {
    const fetcher = stubFetcher(() => new Response('{"error_message":"Error 458"}', { status: 404 }));
    const r = await exchangeWinForBids(fetcher, 1, 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(404);
      expect(r.error).toContain('Error 458');
    }
  });
});
