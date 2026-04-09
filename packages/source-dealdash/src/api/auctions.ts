/**
 * Live auction listing + per-auction state. Mirrors the gonzales.php and
 * auctionFeed endpoints the lifted code uses, but with proper return types
 * so the daemon and tests can consume them without `any`.
 */

import type { DealDashFetcher } from './fetcher.js';

export interface AuctionInfo {
  i: number;            // auction id
  x: number;            // total bids placed by everyone
  me: number;           // bids placed by us
  bookmarked: boolean;
  w?: string;           // current leader username
  bb?: { a: number; c: number }; // BidBuddy: a=allocated, c=remaining
  t?: number;           // seconds until current timer expires (negative = ended)
  t2?: number;          // timer floor (usually 10)
  noNewBidders?: boolean;
  r?: string | number;  // reserve / current price
  s?: number;           // status code (3 = ended)
}

export interface AuctionDetail {
  auctionId: number;
  history: [string, number, string][]; // [price, ts, username]
  timer: number;
  noNewBidders?: boolean;
  logged?: boolean;
}

/**
 * Count distinct bidders from the visible history. DealDash truncates
 * history to the most recent ~10 bids, so this is a lower bound on the
 * true bidder count — but it's all we have without the static feed.
 */
export function getBidders(history: [string, number, string][] | undefined): number {
  if (!history || !history.length) return 0;
  const seen = new Set<string>();
  for (const [, , user] of history) if (user) seen.add(user);
  return seen.size;
}

/** Returns true if the given username appears in the visible history. */
export function historyContainsUser(history: [string, number, string][] | undefined, username: string): boolean {
  if (!history || !username) return false;
  return history.some(h => h[2] === username);
}

export interface AuctionDataResponse {
  details: AuctionDetail[];
  info: Map<number, AuctionInfo>;
  bidBalance: number;
}

export async function getMyLiveAuctions(fetcher: DealDashFetcher): Promise<number[]> {
  try {
    const res = await fetcher('/api/v1/auctionFeed/my-auctions/live');
    if (!res.ok) return [];
    const data = await res.json() as { feed?: { data?: number[] }[] };
    return data.feed?.[0]?.data ?? [];
  } catch { return []; }
}

export async function getAllLiveAuctions(fetcher: DealDashFetcher): Promise<number[]> {
  try {
    const res = await fetcher('/api/v1/auctionFeed/auctions/live');
    if (!res.ok) return [];
    const data = await res.json() as { feed?: { data?: number[] }[] };
    return data.feed?.[0]?.data ?? [];
  } catch { return []; }
}

interface GonzalesResponse {
  auctionsDetails?: AuctionDetail[];
  auctions?: AuctionInfo[];
  p?: { bc?: number };
}

export async function getAuctionData(fetcher: DealDashFetcher, ids: number[]): Promise<AuctionDataResponse> {
  if (!ids.length) return { details: [], info: new Map(), bidBalance: 0 };
  const res = await fetcher(
    `/gonzales.php?idlist=${ids.join(',')}&auctionDetailsIds=${ids.join(',')}&_=${Date.now()}`,
    { headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } },
  );
  if (!res.ok) return { details: [], info: new Map(), bidBalance: 0 };
  const data = (await res.json()) as GonzalesResponse;
  const details = data.auctionsDetails ?? [];
  const info = new Map<number, AuctionInfo>();
  for (const a of data.auctions ?? []) info.set(a.i, a);
  const bidBalance = Number(data.p?.bc ?? 0);
  return { details, info, bidBalance };
}

export interface BiddingHistoryEntry {
  auctionId: number;
  productName: string;
  bidsPlaced: number;
  status: string;
  timestamp: number;
}

export async function getBiddingHistory(fetcher: DealDashFetcher, page = 0): Promise<BiddingHistoryEntry[]> {
  try {
    const res = await fetcher(`/api/v1/users/me/bidding-history?page=${page}`);
    if (!res.ok) return [];
    return (await res.json()) as BiddingHistoryEntry[];
  } catch { return []; }
}
