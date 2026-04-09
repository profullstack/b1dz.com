/**
 * Wins, exchanges, and the orders feed. Same shape as the lifted code,
 * but with a typed return so callers don't need `any`.
 *
 * The orders feed lumps a few different types of rows together; we
 * normalize them into a single Win shape with `exchanged` set when the
 * row is the bid-exchange variant (type=='', auctionId set, bids > 0).
 */

import type { DealDashFetcher } from './fetcher.js';

interface OrderEntry {
  title: string;
  type: string;
  auctionId: string | null;
  price: number;
  status?: string;
  timestamp: number;
  ffid?: string;
  isExchanged?: boolean;
  bids?: number;
}

export interface Win {
  id: number;
  title: string;
  price: number;
  status: string;
  timestamp: number;
  exchanged: boolean;
  exchangedBids: number;
  /** ffid sans leading "A", or null if not present */
  orderId: string | null;
}

function isExchangeRow(o: OrderEntry): boolean {
  return o.type === '' && o.auctionId != null && (o.bids || 0) > 0;
}

export async function getMyWins(fetcher: DealDashFetcher): Promise<Win[]> {
  try {
    const res = await fetcher('/api/v2/orders/my-orders-data');
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: OrderEntry[] };
    return (data.data ?? [])
      .filter(o => o.auctionId && (o.type === 'Auction win' || isExchangeRow(o)))
      .map(o => ({
        id: Number(o.auctionId),
        title: (o.title || '').replace(/^Exchanged for bids:\s*/i, ''),
        price: o.price,
        status: o.status || '',
        timestamp: o.timestamp,
        exchanged: isExchangeRow(o) || o.isExchanged === true,
        exchangedBids: isExchangeRow(o) ? (o.bids || 0) : 0,
        orderId: o.ffid ? o.ffid.replace(/^A/, '') : null,
      }));
  } catch { return []; }
}
