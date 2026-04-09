/**
 * Auction page scraper. Pulls the embedded `dd.auctionFeed = {...}`
 * JSON literal out of the server-rendered HTML and reads the per-auction
 * static block. This is the canonical source for category, BIN price,
 * exchangeable flag, productId, and the post-win exchange data.
 *
 * The brace-balanced extractor is the same one we shipped in the vendored
 * code; lifting it here lets us unit-test it independently.
 */

import type { DealDashFetcher } from './fetcher.js';

export interface AuctionPageInfo {
  name?: string;
  categoryName?: string;
  buyItNowPrice?: number;
  exchangedAt?: number;
  exchangedFor?: number;
  exchangeable?: boolean;
  productId?: number;
  noReEntry?: boolean;
}

/**
 * Walk the HTML looking for `dd.auctionFeed` and extract the balanced
 * JSON literal that follows the assignment. String-aware so escaped
 * quotes don't trip the brace counter.
 */
export function extractAuctionFeed(html: string): Record<string, unknown> | null {
  const marker = 'dd.auctionFeed';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const eq = html.indexOf('=', start);
  if (eq === -1) return null;
  let i = eq + 1;
  while (i < html.length && html[i] !== '{') i++;
  if (i >= html.length) return null;
  const objStart = i;
  let depth = 0, inStr = false, escape = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  try { return JSON.parse(html.slice(objStart, i)); } catch { return null; }
}

/** Pull the static entry for one auction id out of a parsed feed object. */
export function readStaticEntry(feed: Record<string, unknown>, auctionId: number | string): Record<string, unknown> | null {
  const auctions = feed.auctions as { static?: Record<string, Record<string, unknown>> } | undefined;
  if (!auctions?.static) return null;
  return auctions.static[String(auctionId)] ?? null;
}

/** Map a raw static entry to the typed AuctionPageInfo we expose. */
export function entryToPageInfo(entry: Record<string, unknown>): AuctionPageInfo {
  const e = entry;
  const out: AuctionPageInfo = {};
  if (typeof e.name === 'string') out.name = e.name;
  if (typeof e.categoryName === 'string') out.categoryName = e.categoryName;
  if (typeof e.buyItNowPrice === 'number') out.buyItNowPrice = e.buyItNowPrice;
  if (typeof e.exchangedAt === 'number') out.exchangedAt = e.exchangedAt;
  if (typeof e.exchangedFor === 'number') out.exchangedFor = e.exchangedFor;
  if (typeof e.exchangeable === 'boolean') out.exchangeable = e.exchangeable;
  if (typeof e.productId === 'number') out.productId = e.productId;
  if (typeof e.noReEntry === 'boolean') out.noReEntry = e.noReEntry;
  return out;
}

/** End-to-end fetcher: GET /auction/{id} → AuctionPageInfo or null. */
export async function fetchAuctionPageInfo(fetcher: DealDashFetcher, auctionId: number): Promise<AuctionPageInfo | null> {
  const res = await fetcher(`/auction/${auctionId}`);
  if (!res.ok) return null;
  const html = await res.text();
  const feed = extractAuctionFeed(html);
  if (!feed) return null;
  const entry = readStaticEntry(feed, auctionId);
  if (!entry) return null;
  return entryToPageInfo(entry);
}
