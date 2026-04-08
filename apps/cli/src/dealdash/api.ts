// @ts-nocheck
// Vendored from ~/src/dealdash/dealdash.ts. Strict types intentionally
// disabled — this file will be progressively refactored into typed
// modules under @b1dz/source-dealdash. Don't add new code here.
import { loadRootEnv } from '@b1dz/core';
loadRootEnv();
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import chalk from 'chalk';
import Table from 'cli-table3';

const COOKIE = process.env.DEALDASH_COOKIE || '';
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || '';
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER || '';
const ALERT_PHONE = process.env.ALERT_PHONE || '+14086562473';
export const AUTO_BID = process.env.AUTO_BID === '1';
export const USERNAME = process.env.DEALDASH_USERNAME || '';
const SMS_ENABLED = process.env.SMS_ENABLED !== '0';

const HEADERS = {
  'Accept': 'application/json',
  'Cookie': COOKIE,
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
};

export interface AuctionDetail {
  auctionId: number;
  history: [string, number, string][];
  timer: number;
  noNewBidders: boolean;
}

export interface AuctionInfo {
  i: number;
  x: number; // total bids placed in the auction (all users)
  me: number;
  bookmarked: boolean;
  w?: string; // current leader/winner username
  bb?: { a: number; c: number }; // a=BidBuddy allocated, c=current remaining
  t?: number;             // seconds until current timer expires (negative = ended)
  t2?: number;            // timer floor (usually 10)
  noNewBidders?: boolean; // true once new bidders can no longer join
  r?: string | number;    // reserve / current price (string from gonzales)
  s?: number;             // status code (3 = ended)
}

interface GonzalesResponse {
  auctionsDetails: AuctionDetail[];
  auctions: AuctionInfo[];
  p?: { bc?: number };
}

// PERSISTENT CACHES
// Persisted caches: titles, categories, exchangeable flags, BIN prices.
// All keyed by auction id. Reduces API/scrape pressure on restart.
import { readFileSync as __r, writeFileSync as __w, existsSync as __e } from 'node:fs';
const TITLE_FILE = '.title-cache.json';
const CAT_FILE = '.category-cache.json';
const BIN_FILE = '.bin-cache.json';
const EXCH_FILE = '.exchangeable-cache.json';
function loadMap<V>(path: string): Map<number, V> {
  if (!__e(path)) return new Map();
  try { return new Map(Object.entries(JSON.parse(__r(path, 'utf8'))).map(([k, v]) => [Number(k), v as V])); } catch { return new Map(); }
}
function saveMap<V>(path: string, m: Map<number, V>) {
  try {
    const obj: Record<string, V> = {};
    for (const [k, v] of m) obj[k] = v;
    __w(path, JSON.stringify(obj));
  } catch {}
}
export const titleCache = loadMap<string>(TITLE_FILE);
export const categoryCache = loadMap<string>(CAT_FILE);
const categoryInflight = new Set<number>();

// Scrape categoryName out of the auction page HTML — staticData API doesn't
// expose it but it's embedded in the server-rendered page as JSON.
export async function fetchCategoryFromPage(id: number): Promise<void> {
  if (categoryCache.has(id) || categoryInflight.has(id)) return;
  categoryInflight.add(id);
  try {
    const res = await fetch(`https://www.dealdash.com/auction/${id}`, { headers: HEADERS });
    if (!res.ok) return;
    const html = await res.text();
    const m = html.match(/"categoryName"\s*:\s*"([^"]+)"/);
    if (m) categoryCache.set(id, m[1]);
  } catch {
    // swallow — we'll retry next tick
  } finally {
    categoryInflight.delete(id);
  }
}

// Scrape exchange info from the auction page HTML. The server-rendered page
// embeds a `static` block with `exchangedAt` and `exchangedFor` fields when
// the auction was won and exchanged for bids.
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
export const productIdCache = new Map<number, number>(); // auctionId → productId
export const noReEntryCache = new Map<number, boolean>();
export const exchangeableCache = loadMap<boolean>(EXCH_FILE);

// Extract the `dd.auctionFeed = {...};` JSON literal from a server-rendered
// auction page by walking braces from the assignment.
function extractAuctionFeed(html: string): Record<string, unknown> | null {
  const marker = 'dd.auctionFeed';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const eq = html.indexOf('=', start);
  if (eq === -1) return null;
  let i = eq + 1;
  while (i < html.length && html[i] !== '{') i++;
  if (i >= html.length) return null;
  const objStart = i;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const json = html.slice(objStart, i);
  try { return JSON.parse(json); } catch { return null; }
}
const pageInfoCache = new Map<number, AuctionPageInfo>();
const pageInfoInflight = new Set<number>();
export async function fetchAuctionPageInfo(id: number, force = false): Promise<AuctionPageInfo | null> {
  if (!force && pageInfoCache.has(id)) return pageInfoCache.get(id)!;
  if (pageInfoInflight.has(id)) return null;
  pageInfoInflight.add(id);
  try {
    const res = await fetch(`https://www.dealdash.com/auction/${id}`, { headers: HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const info: AuctionPageInfo = {};

    // The auction page embeds the full feed as `dd.auctionFeed = {...};`.
    // Extract that object literal (brace-balanced) and JSON.parse it so we
    // can pull the *exact* entry for this id from `auctions.static`.
    const feed = extractAuctionFeed(html);
    const entry = feed?.auctions?.static?.[String(id)] as Record<string, unknown> | undefined;
    if (entry) {
      if (typeof entry.name === 'string') info.name = entry.name;
      if (typeof entry.categoryName === 'string') info.categoryName = entry.categoryName;
      if (typeof entry.buyItNowPrice === 'number') info.buyItNowPrice = entry.buyItNowPrice;
      if (typeof entry.exchangedAt === 'number') info.exchangedAt = entry.exchangedAt;
      if (typeof entry.exchangedFor === 'number') info.exchangedFor = entry.exchangedFor;
      if (typeof entry.exchangeable === 'boolean') {
        info.exchangeable = entry.exchangeable;
        exchangeableCache.set(id, entry.exchangeable);
      }
      if (typeof entry.productId === 'number') {
        info.productId = entry.productId;
        productIdCache.set(id, entry.productId);
      }
      if (typeof entry.noReEntry === 'boolean') {
        info.noReEntry = entry.noReEntry;
        noReEntryCache.set(id, entry.noReEntry);
      }
      if (info.name) titleCache.set(id, info.name);
      if (info.categoryName) categoryCache.set(id, info.categoryName);
      if (typeof info.buyItNowPrice === 'number') binCache.set(id, info.buyItNowPrice);
      markCacheDirty();
    }
    pageInfoCache.set(id, info);
    // Also populate the title/category caches so the rest of the app benefits.
    if (info.name) titleCache.set(id, info.name);
    if (info.categoryName) categoryCache.set(id, info.categoryName);
    if (typeof info.buyItNowPrice === 'number') binCache.set(id, info.buyItNowPrice);
    return info;
  } catch {
    return null;
  } finally {
    pageInfoInflight.delete(id);
  }
}

export async function fetchCategoriesParallel(ids: number[], limit = 10): Promise<void> {
  const missing = ids.filter(id => !categoryCache.has(id) && !categoryInflight.has(id)).slice(0, limit);
  await Promise.all(missing.map(id => fetchCategoryFromPage(id)));
}
export const binCache = loadMap<number>(BIN_FILE); // buyItNowPrice (retail) per auction

// Periodic flush to disk so caches survive restart.
let cacheDirty = 0;
export function markCacheDirty() { cacheDirty++; if (cacheDirty >= 10) flushCaches(); }
export function flushCaches() {
  cacheDirty = 0;
  saveMap(TITLE_FILE, titleCache);
  saveMap(CAT_FILE, categoryCache);
  saveMap(BIN_FILE, binCache);
  saveMap(EXCH_FILE, exchangeableCache);
}
process.on('exit', flushCaches);
const alertedAuctions = new Set<number>();

// Bid pack mode tunables (more aggressive than normal)
const PACK_REBID_BATCH = 20;
const PACK_REBID_CAP = 400;
const PACK_CANCEL_THRESHOLD = 4; // others — 5+ total bidders means too crowded
export function isPack(id: number): boolean {
  return categoryCache.get(id) === 'Packs';
}
export function packSizeFromTitle(title: string): number {
  const m = title.match(/(\d+)\s*Bid\s*Pack/i);
  return m ? Number(m[1]) : 0;
}

// Bulk fetch titles via the staticData endpoint - one request for all ids
export async function fetchTitlesParallel(ids: number[]): Promise<void> {
  const toFetch = ids.filter(id => !titleCache.has(id));
  if (!toFetch.length) return;

  const qs = toFetch.map(id => `auctionIds%5B%5D=${id}`).join('&');
  const url = `https://www.dealdash.com/api/v1/auction/staticData?${qs}&withBidderDetails=1`;

  try {
    const res = await fetch(url, {
      headers: {
        ...HEADERS,
        'X-Client-Platform': 'desktop-web',
        'X-Client-Build-Version': '7.6.4 / 24083310927',
        'X-Client-Whitelabel': 'dealdash',
      },
    });
    const data = await res.json() as { static?: Record<string, Record<string, unknown>> };
    const map = data.static || {};
    for (const id of toFetch) {
      const entry = map[String(id)] as { name?: string; categoryName?: string; category?: string; buyItNowPrice?: number } | undefined;
      titleCache.set(id, entry?.name || '');
      const cat = entry?.categoryName || entry?.category;
      if (cat) categoryCache.set(id, cat);
      if (typeof entry?.buyItNowPrice === 'number') binCache.set(id, entry.buyItNowPrice);
    }
    markCacheDirty();
  } catch (e) {
    console.log(chalk.red(`  bulk title fetch failed: ${(e as Error).message}`));
    for (const id of toFetch) titleCache.set(id, '');
  }
}

export interface BiddingHistoryEntry {
  auctionId: number;
  productName: string;
  bidsPlaced: number;
  status: string; // "Ongoing", "Won", "Lost", etc.
  timestamp: number;
}

export async function getBiddingHistory(page = 0): Promise<BiddingHistoryEntry[]> {
  try {
    const res = await fetch(`https://www.dealdash.com/api/v1/users/me/bidding-history?page=${page}`, {
      headers: {
        ...HEADERS,
        'X-Client-Platform': 'desktop-web',
        'X-Client-Whitelabel': 'dealdash',
      },
    });
    if (!res.ok) return [];
    return await res.json() as BiddingHistoryEntry[];
  } catch {
    return [];
  }
}

// Walk all pages and return every bidding-history entry
export async function getAllBiddingHistory(): Promise<BiddingHistoryEntry[]> {
  const all: BiddingHistoryEntry[] = [];
  for (let p = 0; p < 200; p++) {
    const batch = await getBiddingHistory(p);
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < 50) break;
  }
  return all;
}

export let sessionExpired = false;
export function clearSessionExpired() { sessionExpired = false; }
function checkAuth(res: Response) {
  if (res.status === 401 || res.status === 403) sessionExpired = true;
}
export async function getMyLiveAuctions(): Promise<number[]> {
  const res = await fetch('https://www.dealdash.com/api/v1/auctionFeed/my-auctions/live', { headers: HEADERS });
  checkAuth(res);
  const data = await res.json();
  return data.feed?.[0]?.data ?? [];
}

interface OrderEntry {
  title: string;
  type: string;
  auctionId: string | null;
  price: number;
  status?: string;
  timestamp: number;
  ffid?: string;        // "A44847882" — strip leading "A" to get the order_id
  isExchanged?: boolean;
}

interface OrdersResponse { data: (OrderEntry & { bids?: number })[] }

async function getOrdersData(): Promise<OrdersResponse> {
  try {
    const res = await fetch('https://www.dealdash.com/api/v2/orders/my-orders-data', { headers: HEADERS });
    return await res.json() as OrdersResponse;
  } catch { return { data: [] }; }
}

export async function getMyWins(): Promise<{ id: number; title: string; price: number; status: string; timestamp: number; exchanged: boolean; exchangedBids: number; orderId: string | null }[]> {
  const data = await getOrdersData();
  return (data.data || [])
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
}

// Notifications: poll DealDash's stack-notifications endpoint. Schema is
// loose so we treat each entry as a generic record with at least an id and
// a piece of text. Caller decides which to alert on.
export interface DDNotification {
  id: string | number;
  text: string;
  raw: Record<string, unknown>;
}
let notificationsDebugDumped = false;
export async function fetchNotifications(): Promise<DDNotification[]> {
  try {
    const res = await fetch('https://www.dealdash.com/api/v1/stack-notifications?page=1', {
      headers: {
        ...HEADERS,
        'Accept': 'application/json, text/plain, */*',
        'X-Client-Platform': 'desktop-web',
        'X-Client-Build-Version': '7.6.4 / 24083310927',
        'X-Client-Whitelabel': 'dealdash',
      },
    });
    if (!res.ok) return [];
    const data = await res.json() as unknown;
    if (!notificationsDebugDumped) {
      notificationsDebugDumped = true;
      try {
        const fs = await import('node:fs');
        fs.writeFileSync('.notifications-debug.json', JSON.stringify(data, null, 2));
      } catch {}
    }
    // Normalize: try common shapes — array, {data:[]}, {notifications:[]}
    let list: Record<string, unknown>[] = [];
    if (Array.isArray(data)) list = data as Record<string, unknown>[];
    else if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (Array.isArray(d.data)) list = d.data as Record<string, unknown>[];
      else if (Array.isArray(d.notifications)) list = d.notifications as Record<string, unknown>[];
      else if (Array.isArray(d.items)) list = d.items as Record<string, unknown>[];
    }
    return list.map(r => {
      const id = (r.id ?? r._id ?? r.uuid ?? JSON.stringify(r).slice(0, 40)) as string | number;
      const text = String(r.text ?? r.title ?? r.message ?? r.body ?? r.headline ?? JSON.stringify(r).slice(0, 200));
      return { id, text, raw: r };
    });
  } catch {
    return [];
  }
}

// POST a wonAuctionExchangeBids request to convert a won auction into bids.
// Mirrors the curl the user captured.
export type ExchangeResult = 'ok' | 'permanent-fail' | 'transient-fail';
export async function exchangeWinForBids(auctionId: number, orderId: string): Promise<ExchangeResult> {
  try {
    const res = await fetch(`https://www.dealdash.com/api/v1/auction/${auctionId}/wonAuctionExchangeBids`, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Client-Platform': 'desktop-web',
        'X-Client-Build-Version': '7.6.4 / 24083310927',
        'X-Client-Whitelabel': 'dealdash',
        'Origin': 'https://www.dealdash.com',
        'Referer': `https://www.dealdash.com/auction/${auctionId}/win-payment`,
      },
      body: JSON.stringify({ order_id: orderId }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log(chalk.red(`  exchange failed ${res.status} for ${auctionId}: ${body.slice(0, 200)}`));
      // 4xx = client error (already exchanged, not eligible, etc.) — don't retry.
      // 5xx / network = transient — retry next tick.
      return res.status >= 400 && res.status < 500 ? 'permanent-fail' : 'transient-fail';
    }
    console.log(chalk.green(`  ⇄ exchanged ${auctionId} (order ${orderId}) for bids`));
    return 'ok';
  } catch (e) {
    console.log(chalk.red(`  exchange error ${auctionId}: ${(e as Error).message}`));
    return 'transient-fail';
  }
}

// Exchanged-for-bids rows: empty type, an auctionId, and a positive bids field.
function isExchangeRow(o: OrderEntry & { bids?: number }): boolean {
  return o.type === '' && o.auctionId != null && (o.bids || 0) > 0;
}

// Current cheapest bid price from the DealDash store page (parsed from inline JS)
let cachedStoreBidPrice = 0;
let storeBidPriceFetchedAt = 0;
export async function getStoreBidPrice(): Promise<number> {
  if (cachedStoreBidPrice && Date.now() - storeBidPriceFetchedAt < 600_000) return cachedStoreBidPrice;
  try {
    const res = await fetch('https://www.dealdash.com/store', { headers: HEADERS });
    const html = await res.text();
    const m = html.match(/promosData\s*=\s*(\{[^;]+\});/);
    if (!m) return cachedStoreBidPrice || 0.15;
    const data = JSON.parse(m[1]) as { bidpacks: { bidprice: string; bids: number }[] };
    const prices = (data.bidpacks || []).map(p => Number(p.bidprice)).filter(n => n > 0);
    cachedStoreBidPrice = prices.length ? Math.min(...prices) : 0.15;
    storeBidPriceFetchedAt = Date.now();
    return cachedStoreBidPrice;
  } catch {
    return cachedStoreBidPrice || 0.15;
  }
}

// Weighted average cost per bid across all bid pack purchases (including freebies)
export async function getCostPerBid(): Promise<number> {
  const data = await getOrdersData();
  let totalPaid = 0;
  let totalBids = 0;
  for (const o of data.data || []) {
    if (typeof o.bids === 'number' && o.bids > 0) {
      totalPaid += o.price || 0;
      totalBids += o.bids;
    }
  }
  return totalBids > 0 ? totalPaid / totalBids : 0.12;
}

export async function getAllLiveAuctions(): Promise<number[]> {
  const res = await fetch('https://www.dealdash.com/api/v1/auctionFeed/auctions/live', { headers: HEADERS });
  const data = await res.json();
  return data.feed?.[0]?.data ?? [];
}

export async function getAuctionData(ids: number[]): Promise<{ details: AuctionDetail[], info: Map<number, AuctionInfo>, bidBalance: number }> {
  if (!ids.length) return { details: [], info: new Map(), bidBalance: 0 };
  const res = await fetch(`https://www.dealdash.com/gonzales.php?idlist=${ids.join(',')}&auctionDetailsIds=${ids.join(',')}&_=${Date.now()}`, { headers: { ...HEADERS, 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } });
  const data: GonzalesResponse = await res.json();

  const info = new Map<number, AuctionInfo>();
  for (const a of data.auctions || []) {
    info.set(a.i, a);
  }

  return { details: data.auctionsDetails || [], info, bidBalance: data.p?.bc ?? 0 };
}

export function getBidders(history: [string, number, string][]): string[] {
  return history?.length ? [...new Set(history.map(h => h[2]))] : [];
}

export async function bookBid(auctionId: number, count = 1): Promise<boolean> {
  try {
    const res = await fetch(`https://www.dealdash.com/api/v1/auction/${auctionId}/bidBuddy`, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/json',
        'Origin': 'https://www.dealdash.com',
        'Referer': `https://www.dealdash.com/auction/${auctionId}`,
        'X-Client-Platform': 'desktop-web',
        'X-Client-Whitelabel': 'dealdash',
      },
      body: JSON.stringify({ bid_count: count }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.log(chalk.red(`  bid failed ${res.status} for ${auctionId}: ${body.slice(0, 200)}`));
      return false;
    }
    console.log(chalk.green(`  ✓ booked ${count} bid${count > 1 ? 's' : ''} on ${auctionId}`));
    // Bump the baseline so the next tick's delta isn't masked by this booking
    prevBooked.set(auctionId, (prevBooked.get(auctionId) || 0) + count);
    return true;
  } catch (e) {
    console.log(chalk.red(`  bid error ${auctionId}: ${(e as Error).message}`));
    return false;
  }
}

export async function cancelBidBuddy(auctionId: number): Promise<boolean> {
  try {
    const res = await fetch(`https://www.dealdash.com/api/v1/auction/${auctionId}/bidBuddy`, {
      method: 'DELETE',
      headers: {
        ...HEADERS,
        'Origin': 'https://www.dealdash.com',
        'Referer': `https://www.dealdash.com/auction/${auctionId}`,
        'X-Client-Platform': 'desktop-web',
        'X-Client-Whitelabel': 'dealdash',
      },
    });
    const body = await res.text();
    if (!res.ok) {
      console.log(chalk.red(`  cancel failed ${res.status} for ${auctionId}: ${body.slice(0, 200)}`));
      return false;
    }
    console.log(chalk.yellow(`  ✗ cancelled BidBuddy on ${auctionId}`));
    return true;
  } catch (e) {
    console.log(chalk.red(`  cancel error ${auctionId}: ${(e as Error).message}`));
    return false;
  }
}

// Track total bids spent per auction, persisted across restarts
const REBID_BATCH = 5;
const REBID_CAP = 200;
const SPENT_FILE = '.bids-spent.json';

function loadSpent(): Map<number, number> {
  if (!existsSync(SPENT_FILE)) return new Map();
  try {
    const obj = JSON.parse(readFileSync(SPENT_FILE, 'utf8')) as Record<string, number>;
    return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
  } catch {
    return new Map();
  }
}

function saveSpent(m: Map<number, number>) {
  const obj: Record<string, number> = {};
  for (const [k, v] of m) obj[k] = v;
  try { writeFileSync(SPENT_FILE, JSON.stringify(obj, null, 2)); } catch {}
}

export const bidsSpent = loadSpent();
// Last seen "booked" count per auction, for delta tracking
const prevBooked = new Map<number, number>();
// Last seen leader per auction id, for win detection
const lastLeader = new Map<number, string>();
const lastTitle = new Map<number, string>();
const announcedWins = new Set<number>();
// Persisted list of all wins for the session display
const wonAuctions: { id: number; title: string; at: string }[] = [];

// Lifetime bid total — refreshed every 60s, not every tick (paginated, slow)
let lifetimeBidsEver = 0;
let lifetimeAuctionsEver = 0;
let lifetimeRefreshedAt = 0;
export function getLifetimeStats() {
  return { bids: lifetimeBidsEver, auctions: lifetimeAuctionsEver };
}

export async function refreshLifetimeIfStale() {
  if (Date.now() - lifetimeRefreshedAt < 30_000) return;
  const all = await getAllBiddingHistory();
  lifetimeBidsEver = all.reduce((s, e) => s + (e.bidsPlaced || 0), 0);
  lifetimeAuctionsEver = all.length;
  lifetimeRefreshedAt = Date.now();
  // Backfill bidsSpent + titleCache for ALL historical auctions, not just page 0
  for (const e of all) {
    bidsSpent.set(e.auctionId, e.bidsPlaced);
    if (e.productName) titleCache.set(e.auctionId, e.productName);
  }
  saveSpent(bidsSpent);
}

async function sendSMS(msg: string): Promise<boolean> {
  if (!SMS_ENABLED) return false;
  if (!TELNYX_API_KEY || !TELNYX_FROM_NUMBER) {
    console.log(chalk.red(`  SMS skipped: missing TELNYX_API_KEY or TELNYX_FROM_NUMBER`));
    return false;
  }
  try {
    const res = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: TELNYX_FROM_NUMBER, to: ALERT_PHONE, text: msg }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.log(chalk.red(`  SMS failed ${res.status}: ${body}`));
      return false;
    }
    console.log(chalk.green(`  SMS sent to ${ALERT_PHONE}`));
    return true;
  } catch (e) {
    console.log(chalk.red(`  SMS error: ${(e as Error).message}`));
    return false;
  }
}

function clearScreen() {
  process.stdout.write('\x1B[2J\x1B[0f');
}

// Buffer all console output, then flush in one write to eliminate flicker
let frameBuffer: string[] = [];
const realLog = console.log;
function startFrame() {
  frameBuffer = [];
  console.log = (...args: unknown[]) => { frameBuffer.push(args.map(String).join(' ')); };
}
function flushFrame() {
  console.log = realLog;
  // Cursor home + clear-to-end-of-screen, then write entire buffered frame at once
  process.stdout.write('\x1B[H\x1B[0J' + frameBuffer.join('\n') + '\n');
}

export interface DisplayAuction {
  id: number;
  bidders: number;
  othersBidding: number;
  ddPrice: string;
  leader: string;
  locked: boolean;
  title: string;
  bidsBooked: number;
  bidsSpent: number;
  totalBids: number;
}

export function toDisplay(d: AuctionDetail, info: Map<number, AuctionInfo>): DisplayAuction {
  const auctionInfo = info.get(d.auctionId);
  const allBidders = getBidders(d.history);
  return {
    id: d.auctionId,
    bidders: allBidders.length,
    othersBidding: allBidders.filter(n => n !== USERNAME).length,
    ddPrice: d.history[0]?.[0] ?? 'N/A',
    leader: d.history[0]?.[2] ?? 'N/A',
    locked: d.noNewBidders,
    title: titleCache.get(d.auctionId) || '',
    bidsBooked: auctionInfo?.bb?.c ?? 0,
    bidsSpent: bidsSpent.get(d.auctionId) ?? 0,
    totalBids: auctionInfo?.x ?? 0,
  };
}

function renderMyAuctions(auctions: DisplayAuction[]): string {
  const sorted = [...auctions].sort((a, b) => a.bidders - b.bidders);

  const table = new Table({
    head: ['Bid', 'Price', 'Booked', 'Spent', 'TotBids', 'Title', 'Link'].map(h => chalk.white(h)),
    style: { head: [], border: ['gray'] },
    colWidths: [5, 9, 8, 7, 9, 62, null],
    wordWrap: false,
  });

  for (const a of sorted) {
    const cnt = a.bidders <= 2 ? chalk.bgRed.white.bold(`${a.bidders}`) : a.bidders <= 4 ? chalk.yellow(`${a.bidders}`) : chalk.gray(`${a.bidders}`);
    const locked = a.locked ? ' 🔒' : '';
    const booked = a.bidsBooked > 0 ? chalk.green(`${a.bidsBooked}`) : chalk.gray('0');
    const spent = a.bidsSpent > 0 ? chalk.magenta(`${a.bidsSpent}`) : chalk.gray('0');
    const title = a.title ? a.title.slice(0, 60) : chalk.gray('(loading...)');
    const link = `https://www.dealdash.com/auction/${a.id}${locked}`;

    table.push([cnt, chalk.cyan(`$${a.ddPrice}`), booked, spent, chalk.gray(`${a.totalBids}`), title, chalk.blue(link)]);
  }

  return table.toString();
}

function renderJoinable(auctions: DisplayAuction[]): string {
  const sorted = [...auctions].sort((a, b) => a.bidders - b.bidders);

  const table = new Table({
    head: ['Bid', 'Price', 'Booked', 'Title', 'Link'].map(h => chalk.white(h)),
    style: { head: [], border: ['gray'] },
    colWidths: [5, 9, 8, 62, null],
    wordWrap: false,
  });

  for (const a of sorted) {
    const cnt = a.bidders <= 2 ? chalk.bgRed.white.bold(`${a.bidders}`) : chalk.yellow(`${a.bidders}`);
    const booked = a.bidsBooked > 0 ? chalk.green(`${a.bidsBooked}`) : chalk.gray('0');
    const title = a.title ? a.title.slice(0, 60) : chalk.gray('(loading...)');
    const link = `https://www.dealdash.com/auction/${a.id}`;

    table.push([cnt, chalk.cyan(`$${a.ddPrice}`), booked, title, chalk.blue(link)]);
  }

  return table.toString();
}

async function checkAuctions() {
  startFrame();
  const ts = new Date().toLocaleTimeString();

  console.log(chalk.bold.cyan('╔═══════════════════════════════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║') + chalk.bold.white('                           🎯 DealDash Auction Monitor 🎯                               ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('╚═══════════════════════════════════════════════════════════════════════════════════════════╝'));
  console.log(chalk.gray(`\n  ${ts}  |  SMS: ${TELNYX_API_KEY ? chalk.green('ON') : chalk.red('OFF')}  |  AutoBid: ${AUTO_BID ? chalk.green('ON') : chalk.gray('OFF')}  |  Cached: ${titleCache.size} titles`));

  const [myIds, allIds, history, wins, costPerBid, storeBidPrice] = await Promise.all([getMyLiveAuctions(), getAllLiveAuctions(), getBiddingHistory(), getMyWins(), getCostPerBid(), getStoreBidPrice()]);
  await refreshLifetimeIfStale();
  const { details: allDetails, info, bidBalance } = await getAuctionData([...new Set([...myIds, ...allIds])]);

  // Authoritative bidsPlaced from history endpoint (replaces delta tracking)
  for (const h of history) {
    bidsSpent.set(h.auctionId, h.bidsPlaced);
    if (h.productName) titleCache.set(h.auctionId, h.productName);
  }
  saveSpent(bidsSpent);

  // Wins from the orders endpoint (filtered to type === "Auction win")
  for (const w of wins) {
    if (!announcedWins.has(w.id)) {
      announcedWins.add(w.id);
      wonAuctions.push({ id: w.id, title: w.title, at: new Date().toLocaleTimeString() });
    }
  }

  const myInfos = [...info.values()].filter(a => myIds.includes(a.i));

  // Track bids spent: when "booked" count drops, the difference was consumed
  let dirty = false;
  for (const a of myInfos) {
    const cur = a.bb?.c ?? 0;
    const prev = prevBooked.get(a.i);
    if (prev !== undefined && cur < prev) {
      const consumed = prev - cur;
      bidsSpent.set(a.i, (bidsSpent.get(a.i) || 0) + consumed);
      console.log(chalk.magenta(`  💸 ${a.i}: consumed ${consumed} (${prev}→${cur}), total spent ${bidsSpent.get(a.i)}`));
      dirty = true;
    }
    prevBooked.set(a.i, cur);
  }
  if (dirty) saveSpent(bidsSpent);

  // (legacy win-by-disappearance heuristic removed — was unreliable)

  // Lost auctions: bidding-history entries marked Sold where I'm not in the wins set
  const winSet = new Set(wins.map(w => w.id));
  const lostAuctions: { id: number; title: string }[] = [];
  for (const h of history) {
    if (h.status === 'Sold' && !winSet.has(h.auctionId)) {
      lostAuctions.push({ id: h.auctionId, title: h.productName });
    }
  }

  const totalBooked = myInfos.reduce((s, a) => s + (a.bb?.c || 0), 0);
  const totalSpent = [...bidsSpent.values()].reduce((s, v) => s + v, 0);
  const balanceStr = bidBalance < REBID_BATCH ? chalk.bold.bgRed.white(`${bidBalance}`) : chalk.bold.cyan(`${bidBalance}`);
  console.log(chalk.gray(`  💰 Balance: ${balanceStr} bids  |  📌 Booked: ${chalk.bold.green(totalBooked)} across ${myIds.length} auctions  |  💸 Spent: ${chalk.bold.magenta(totalSpent)} bids (${bidsSpent.size} auctions tracked)`));
  console.log(chalk.gray(`  📜 Lifetime: ${chalk.bold.magenta(lifetimeBidsEver)} bids across ${chalk.bold(lifetimeAuctionsEver)} auctions  ($${(lifetimeBidsEver * costPerBid).toFixed(2)} spent at $${costPerBid.toFixed(3)}/bid)`));
  if (bidBalance < REBID_BATCH) {
    console.log(chalk.bold.bgRed.white(`  ⚠️  OUT OF BIDS — buy more at https://www.dealdash.com/buy-bids  ⚠️`));
  }

  const myDetails = allDetails.filter(d => myIds.includes(d.auctionId));
  const joinable = allDetails.filter(d => {
    const n = getBidders(d.history).length;
    return n <= 2 && !d.noNewBidders && !myIds.includes(d.auctionId);
  });

  // MY AUCTIONS
  let waiting: DisplayAuction[] = [];
  console.log(chalk.bold.yellow(`\n  📋 MY AUCTIONS (${myDetails.length})`));
  if (myDetails.length) {
    await fetchTitlesParallel(myDetails.map(d => d.auctionId));
    const allDisplay = myDetails.map(d => toDisplay(d, info));
    // Show auctions I have booked OR with ≤2 bidders
    const visible = allDisplay.filter(d => d.bidsBooked > 0 || d.bidders <= 2);
    // Waiting to re-join: I'm in (have bid) but it's too crowded right now
    waiting = allDisplay.filter(d => {
      // I'm in if I have placed bids per history endpoint, OR I'm in recent history
      const placed = (bidsSpent.get(d.id) || 0) > 0;
      const inHist = (myDetails.find(x => x.auctionId === d.id)?.history || []).some(h => h[2] === USERNAME);
      return (placed || inHist) && d.bidsBooked === 0 && d.bidders === 3 && d.totalBids > 2;
    });

    // Stats across ALL live auctions (not just mine)
    const allCounts = allDetails.map(d => getBidders(d.history).length);
    const stat1 = allCounts.filter(n => n === 1).length;
    const stat2 = allCounts.filter(n => n === 2).length;
    const stat3 = allCounts.filter(n => n === 3).length;
    const stat4plus = allCounts.filter(n => n >= 4).length;
    console.log(chalk.gray(`  📊 Live across feed:  1 bidder: ${chalk.bold.green(stat1)}  |  2: ${chalk.bold.cyan(stat2)}  |  3: ${chalk.bold.yellow(stat3)}  |  4+: ${chalk.bold.red(stat4plus)}`));
    console.log(renderMyAuctions(visible));

    for (const d of allDisplay) {
      if (d.bidders <= 2 && !alertedAuctions.has(d.id)) {
        const ok = await sendSMS(`🔥 ${d.bidders} bidders! $${d.ddPrice}\n${d.title || ''}\nhttps://www.dealdash.com/auction/${d.id}`);
        if (ok) alertedAuctions.add(d.id);
      }
      if (d.bidders > 2) alertedAuctions.delete(d.id);

      // I'm "in" if I have a queue, ever bid here (lifetime), or appear in recent history.
      // The lifetime check prevents 1v1 dropouts when my username temporarily falls out
      // of the recent ~9-entry history window during bursts.
      const auctionInfo = info.get(d.id);
      const lifetimePlaced = bidsSpent.get(d.id) || 0;
      const inRecentHistory = (allDetails.find(x => x.auctionId === d.id)?.history || []).some(h => h[2] === USERNAME);
      const iAmIn = d.bidsBooked > 0 || (auctionInfo?.me ?? 0) > 0 || lifetimePlaced > 0 || inRecentHistory;

      // Initial entry: bookmarked/favorited auction with ≤2 bidders, never joined → book 1
      if (AUTO_BID && !iAmIn && d.bidders <= 2 && d.bidsBooked === 0 && bidBalance >= 1) {
        await bookBid(d.id, 1);
        continue;
      }

      const pack = isPack(d.id);
      const cancelAt = pack ? PACK_CANCEL_THRESHOLD : 3;
      const batch = pack ? PACK_REBID_BATCH : REBID_BATCH;
      // For packs, cap at 70% of pack size; otherwise the static cap
      const packSize = pack ? packSizeFromTitle(d.title) : 0;
      const cap = pack ? Math.max(PACK_REBID_CAP, Math.floor(packSize * 0.7)) : REBID_CAP;

      // Sunk cost guard: 30+ bids in (profitability not checked here, dealdash.ts has no market data)
      const heavyInvestment = (bidsSpent.get(d.id) || 0) >= 30;
      // Auto cancel: too crowded (but not if we've already invested heavily)
      if (AUTO_BID && iAmIn && d.othersBidding >= cancelAt && !heavyInvestment) {
        await cancelBidBuddy(d.id);
        continue;
      }

      // Auto rebid: 1-(cancelAt-1) other bidders, top up when ≤2 booked
      if (AUTO_BID && iAmIn && d.othersBidding >= 1 && d.othersBidding < cancelAt && d.bidsBooked <= 2) {
        const spent = bidsSpent.get(d.id) || 0;
        if (spent >= cap) {
          console.log(chalk.gray(`  ${d.id}${pack ? ' [PACK]' : ''}: hit ${cap}-bid cap, holding`));
        } else if (bidBalance < batch) {
          // handled by the warning below; just skip silently here
        } else {
          const ok = await bookBid(d.id, batch);
          if (ok) {
            bidsSpent.set(d.id, spent + batch);
            saveSpent(bidsSpent);
          }
        }
      }
    }
  } else {
    console.log(chalk.gray('  None\n'));
  }

  // WAITING TO RE-JOIN (sorted by your investment, top 10)
  if (waiting.length) {
    const sortedWaiting = [...waiting].sort((a, b) => b.bidsSpent - a.bidsSpent);
    console.log(chalk.bold.magenta(`\n  ⏸  WAITING TO RE-JOIN (${waiting.length})  — too crowded, will rebid when bidders drop`));
    console.log(renderMyAuctions(sortedWaiting.slice(0, 10)));
    if (waiting.length > 10) console.log(chalk.gray(`  +${waiting.length - 10} more`));
  }

  // JOINABLE
  console.log(chalk.bold.green(`\n  🎰 JOINABLE ≤2 bidders (${joinable.length})`));
  if (joinable.length) {
    await fetchTitlesParallel(joinable.slice(0, 10).map(d => d.auctionId));
    const display = joinable.slice(0, 10).map(d => toDisplay(d, info));
    console.log(renderJoinable(display));
    if (joinable.length > 10) console.log(chalk.gray(`  +${joinable.length - 10} more`));

    for (const d of display) {
      if (d.bidders <= 2 && !alertedAuctions.has(d.id)) {
        const ok = await sendSMS(`🎰 JOIN: ${d.bidders} bidders! $${d.ddPrice}\n${d.title || ''}\nhttps://www.dealdash.com/auction/${d.id}`);
        if (ok) alertedAuctions.add(d.id);
      }
      // Auto-bid: 2 bids on auctions with 2 active bidders, 1 bid otherwise
      if (AUTO_BID && d.bidders <= 2 && d.bidsBooked === 0) {
        const count = d.bidders === 2 ? 2 : 1;
        if (bidBalance >= count) await bookBid(d.id, count);
      }
    }
  } else {
    console.log(chalk.gray('  None\n'));
  }

  // WON AUCTIONS — rebuild fresh each tick from authoritative wins
  if (wins.length) {
    console.log(chalk.bold.green(`\n  🏆 WON AUCTIONS (${wins.length})  — cost/bid: $${costPerBid.toFixed(4)} (store rate: $${storeBidPrice.toFixed(2)})`));
    let totalCostAll = 0;
    for (const w of wins) {
      const bidsPlaced = bidsSpent.get(w.id) || 0;
      const bidCost = bidsPlaced * costPerBid;
      const totalCost = bidCost + w.price;
      totalCostAll += totalCost;
      console.log(`  ${chalk.green('✓')} ${chalk.bold.white(w.title)}`);
      console.log(`     ${chalk.gray(`bids: ${bidsPlaced} × $${costPerBid.toFixed(3)} = $${bidCost.toFixed(2)}  |  win: $${w.price.toFixed(4)}  |  ${chalk.bold.yellow(`total cost: $${totalCost.toFixed(2)}`)}`)}`);
      console.log(`     ${chalk.blue(`https://www.dealdash.com/auction/${w.id}`)}`);
    }
    console.log(chalk.bold.yellow(`  💰 Grand total cost: $${totalCostAll.toFixed(2)}`));
  }

  // LOST AUCTIONS
  if (lostAuctions.length) {
    console.log(chalk.bold.red(`\n  ❌ LOST AUCTIONS (${lostAuctions.length})`));
    for (const l of lostAuctions.slice(0, 10)) {
      console.log(`  ${chalk.red('✗')} ${chalk.white(l.title)}  ${chalk.blue(`https://www.dealdash.com/auction/${l.id}`)}`);
    }
    if (lostAuctions.length > 10) console.log(chalk.gray(`  +${lostAuctions.length - 10} more`));
  }

  console.log(chalk.gray('\n  🔒 = No new entries  |  Ctrl+C to exit'));
  flushFrame();
}

async function main() {
  console.log('Starting DealDash Monitor...');
  console.log('Loading lifetime bidding history (all pages)...');
  await refreshLifetimeIfStale();
  console.log(`Loaded ${lifetimeAuctionsEver} historical auctions, ${lifetimeBidsEver} bids ever.`);
  await checkAuctions();
  setInterval(checkAuctions, 5000);
}

process.on('SIGINT', () => process.exit());

if (process.env.DEALDASH_NO_MAIN !== '1') {
  main().catch(console.error);
}
