/**
 * pollOnce — the single function the daemon calls per user per tick.
 *
 * Responsibilities (data-gathering phase):
 *   1. Hydrate per-user state from a Storage adapter (caches + cursors)
 *   2. Fetch my live auctions, my wins, bidding history, cost/store prices
 *   3. Fetch per-auction data + page info for anything we haven't scraped
 *   4. Normalize into a PollResult the daemon can persist / the UI can render
 *   5. Write updated caches back to storage
 *
 * Strategy decisions (should-I-bid, focus mode, dup detection) live in
 * Phase 3d — this function intentionally does NO mutations against
 * DealDash. The TUI still owns the autobid orchestrator for now.
 *
 * pollOnce is pure in the sense that `ctx` carries every side-effect
 * dependency: fetcher (HTTP), storage (persistence), now (clock). Tests
 * inject stubs for all three.
 */

import type { Storage } from '@b1dz/core';
import type { DealDashFetcher } from './api/fetcher.js';
import {
  getMyLiveAuctions,
  getAllLiveAuctions,
  getAuctionData,
  getBiddingHistory,
  type AuctionDetail,
  type AuctionInfo,
  type BiddingHistoryEntry,
} from './api/auctions.js';
import { getMyWins, type Win } from './api/wins.js';
import { fetchAuctionPageInfo, type AuctionPageInfo } from './api/page.js';
import type { StrategyConfig, MarketEntry } from './types.js';
import { DEFAULT_STRATEGY } from './types.js';

// ---------- persisted per-user state ----------

export interface DealDashCaches {
  titles: Record<number, string>;
  categories: Record<number, string>;
  bin: Record<number, number>;
  exchangeable: Record<number, boolean>;
  productIds: Record<number, number>;
  noReEntry: Record<number, boolean>;
  bidsSpent: Record<number, number>;
  marketPrices: Record<string, MarketEntry>;
  exchangeRates: Record<number, number>; // productId → bids offered
}

export interface DealDashSourceState {
  caches?: Partial<DealDashCaches>;
  // Credentials live in payload.credentials — loaded by the daemon via its
  // own helper, not by pollOnce.
}

function emptyCaches(): DealDashCaches {
  return {
    titles: {},
    categories: {},
    bin: {},
    exchangeable: {},
    productIds: {},
    noReEntry: {},
    bidsSpent: {},
    marketPrices: {},
    exchangeRates: {},
  };
}

function hydrate(partial: Partial<DealDashCaches> | undefined): DealDashCaches {
  const base = emptyCaches();
  if (!partial) return base;
  const src = partial as unknown as Record<string, unknown>;
  const dst = base as unknown as Record<string, unknown>;
  for (const key of Object.keys(base)) {
    const v = src[key];
    if (v && typeof v === 'object') {
      dst[key] = { ...(v as Record<string, unknown>) };
    }
  }
  return base;
}

// ---------- input/output shapes ----------

export interface PollContext {
  userId: string;
  fetcher: DealDashFetcher;
  storage: Storage;
  cfg?: StrategyConfig;
  /** Override for tests; defaults to Date.now */
  now?: () => number;
  /** Rate-limit page-info scrapes per tick (default 10) */
  pageInfoBudget?: number;
}

export interface PollResult {
  /** Current bid balance from the gonzales response */
  bidBalance: number;
  /** Live store rate (scraped by a separate helper, 0 if unknown) */
  storeBidPrice: number;
  /** Union of my live auctions + live feed — deduped, keyed by id */
  details: AuctionDetail[];
  info: Map<number, AuctionInfo>;
  /** My live auction ids (as reported by DealDash) */
  myIds: number[];
  /** Ids in the global live feed */
  allIds: number[];
  /** Normalized wins (orders feed) */
  wins: Win[];
  /** Paginated history (page 0 only) */
  history: BiddingHistoryEntry[];
  /** Caches after any hydration / new writes — already persisted */
  caches: DealDashCaches;
  /** Newly-scraped page info this tick, keyed by auction id */
  newPageInfo: Map<number, AuctionPageInfo>;
}

// ---------- main ----------

const SOURCE_ID = 'dealdash';
const STATE_COLLECTION = 'source-state';

export async function pollOnce(ctx: PollContext): Promise<PollResult> {
  const cfg = ctx.cfg ?? DEFAULT_STRATEGY;
  const now = ctx.now ?? Date.now;
  const pageInfoBudget = ctx.pageInfoBudget ?? 10;

  // 1. Hydrate state
  const stored = await ctx.storage.get<DealDashSourceState>(STATE_COLLECTION, SOURCE_ID);
  const caches = hydrate(stored?.caches);

  // 2. Parallel fetches for everything tick-independent
  const [myIds, allIds, wins, history] = await Promise.all([
    getMyLiveAuctions(ctx.fetcher),
    getAllLiveAuctions(ctx.fetcher),
    getMyWins(ctx.fetcher),
    getBiddingHistory(ctx.fetcher, 0),
  ]);

  // 3. Combined auction data for everything we care about
  const union = Array.from(new Set([...myIds, ...allIds]));
  const { details, info, bidBalance } = await getAuctionData(ctx.fetcher, union);

  // 4. Authoritative bidsSpent from history (overwrites cached)
  for (const h of history) caches.bidsSpent[h.auctionId] = h.bidsPlaced;

  // 5. Scrape page info for auctions we've never seen + win ids (budgeted)
  const newPageInfo = new Map<number, AuctionPageInfo>();
  const toScrape: number[] = [];
  for (const id of [...myIds, ...wins.map(w => w.id)]) {
    if (caches.titles[id] && caches.categories[id]) continue;
    toScrape.push(id);
    if (toScrape.length >= pageInfoBudget) break;
  }
  if (toScrape.length) {
    const infos = await Promise.all(toScrape.map(id => fetchAuctionPageInfo(ctx.fetcher, id)));
    for (let i = 0; i < toScrape.length; i++) {
      const id = toScrape[i];
      const pi = infos[i];
      if (!pi) continue;
      newPageInfo.set(id, pi);
      if (pi.name) caches.titles[id] = pi.name;
      if (pi.categoryName) caches.categories[id] = pi.categoryName;
      if (pi.buyItNowPrice != null) caches.bin[id] = pi.buyItNowPrice;
      if (pi.exchangeable != null) caches.exchangeable[id] = pi.exchangeable;
      if (pi.productId != null) caches.productIds[id] = pi.productId;
      if (pi.noReEntry != null) caches.noReEntry[id] = pi.noReEntry;
    }
  }

  // 6. Persist the updated caches back to source_state
  const nextState: DealDashSourceState & { sourceId?: string; updatedAt?: number } = {
    ...(stored ?? {}),
    caches,
    sourceId: SOURCE_ID,
    updatedAt: now(),
  };
  await ctx.storage.put<DealDashSourceState>(STATE_COLLECTION, SOURCE_ID, nextState);

  void cfg; // cfg will be consumed in Phase 3d when strategy moves here

  return {
    bidBalance,
    storeBidPrice: 0, // TODO Phase 3d — wire getStoreBidPrice
    details,
    info,
    myIds,
    allIds,
    wins,
    history,
    caches,
    newPageInfo,
  };
}
