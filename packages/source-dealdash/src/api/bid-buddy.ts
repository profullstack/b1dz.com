/**
 * Bid actions: book, cancel, exchange. These are the only mutations the
 * daemon performs against DealDash. Each is a simple HTTP call wrapped
 * with sane error handling.
 */

import type { DealDashFetcher } from './fetcher.js';

export type ActionResult =
  | { ok: true }
  | { ok: false; status?: number; error: string };

export async function bookBid(fetcher: DealDashFetcher, auctionId: number, count = 1): Promise<ActionResult> {
  try {
    const res = await fetcher(`/api/v1/auction/${auctionId}/bidBuddy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: Math.max(1, count) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function cancelBidBuddy(fetcher: DealDashFetcher, auctionId: number): Promise<ActionResult> {
  try {
    const res = await fetcher(`/api/v1/auction/${auctionId}/bidBuddy`, { method: 'DELETE' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function exchangeWinForBids(fetcher: DealDashFetcher, auctionId: number, orderId: string): Promise<ActionResult> {
  try {
    const res = await fetcher(`/api/v1/auction/${auctionId}/wonAuctionExchangeBids`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://www.dealdash.com',
        Referer: `https://www.dealdash.com/auction/${auctionId}/win-payment`,
      },
      body: JSON.stringify({ order_id: orderId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
