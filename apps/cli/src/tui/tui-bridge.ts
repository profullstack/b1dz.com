/**
 * TUI bridge — wires the typed @b1dz/source-dealdash modules into the TUI's
 * tick cycle so it no longer needs inline copies of fetching + strategy logic.
 *
 * Exports:
 *   - initBridge()    — one-time setup (build fetcher, storage)
 *   - pollTick()      — data-gathering phase (replaces inline API calls)
 *   - decideTick()    — strategy + execution phase (replaces inline AUTO_BID)
 *
 * The TUI still owns: React rendering, ValueSERP market prices, velocity
 * tracking, daily P/L, notifications, auto-exchange, seen-auctions tracker.
 */

import {
  pollOnce,
  toDisplayAuctions,
  decide,
  bookBid,
  cancelBidBuddy,
  exchangeWinForBids,
  makeDealDashFetcher,
  makeBalanceMode,
  DEFAULT_STRATEGY,
  isPack,
  type PollResult,
  type DealDashFetcher,
  type DealDashAuction,
  type ModeState,
  type DecisionResult,
  type MarketEntry,
  type StrategyConfig,
} from '@b1dz/source-dealdash';
import type { Storage } from '@b1dz/core';
import { makeTuiStorage } from './tui-storage.js';
import { parseDealDashCookie } from '../dealdash/credentials.js';

// ---------- singleton state ----------

let fetcher: DealDashFetcher | null = null;
let storage: Storage | null = null;

/** Mode state persisted across ticks (same shape the daemon uses). */
let modeState: ModeState = {
  balance: makeBalanceMode(),
  focusKeepId: null,
  lifeSavingMode: process.env.LIFE_SAVING_MODE === '1',
  exchangeableOnly: process.env.EXCHANGEABLE_ONLY === '1',
  stopLoss: false,
  lockedProductIds: new Set(),
};

// ---------- init ----------

export function initBridge(): void {
  // Build fetcher from the DEALDASH_COOKIE env var that ensureDealDashCookie()
  // already populated before the TUI module loaded.
  const raw = process.env.DEALDASH_COOKIE || '';
  const parsed = parseDealDashCookie(raw);
  if (!parsed) {
    throw new Error('Cannot init TUI bridge: DEALDASH_COOKIE not set or unparseable');
  }
  fetcher = makeDealDashFetcher(parsed);
  storage = makeTuiStorage();
}

export function getFetcher(): DealDashFetcher {
  if (!fetcher) throw new Error('TUI bridge not initialized — call initBridge() first');
  return fetcher;
}

// ---------- mode state accessors (for TUI key toggles) ----------

export function getModeState(): ModeState { return modeState; }

export function setLifeSavingMode(on: boolean): void { modeState = { ...modeState, lifeSavingMode: on }; }
export function setExchangeableOnly(on: boolean): void { modeState = { ...modeState, exchangeableOnly: on }; }
export function setStopLoss(on: boolean): void { modeState = { ...modeState, stopLoss: on }; }
export function setLockedProductIds(ids: Set<number>): void { modeState = { ...modeState, lockedProductIds: ids }; }
export function getFocusKeepId(): number | null { return modeState.focusKeepId; }

// ---------- polling ----------

export interface PollTickResult {
  poll: PollResult;
  auctions: DealDashAuction[];
}

export async function pollTick(): Promise<PollTickResult> {
  if (!fetcher || !storage) throw new Error('TUI bridge not initialized');
  const userId = process.env.B1DZ_USER_ID || 'local';
  const poll = await pollOnce({ userId, fetcher, storage });

  const username = process.env.DEALDASH_USERNAME || '';
  const auctions = toDisplayAuctions({
    details: poll.details,
    info: poll.info,
    titles: poll.caches.titles,
    bidsSpent: poll.caches.bidsSpent,
    username,
  });

  return { poll, auctions };
}

// ---------- strategy + execution ----------

export interface DecideTickResult {
  result: DecisionResult;
  /** Number of actions executed (some may fail silently) */
  executed: number;
}

export async function decideTick(
  poll: PollResult,
  auctions: DealDashAuction[],
  cfg: StrategyConfig = DEFAULT_STRATEGY,
): Promise<DecideTickResult> {
  if (!fetcher) throw new Error('TUI bridge not initialized');

  const result = decide({
    bidBalance: poll.bidBalance,
    auctions,
    categoryOf: (id) => poll.caches.categories[id],
    marketOf: (a): MarketEntry | null => poll.caches.marketPrices[a.title] ?? null,
    productIdOf: (id) => poll.caches.productIds[id],
    exchangeableOf: (id) => poll.caches.exchangeable[id],
    exchangeRateOf: (pid) => poll.caches.exchangeRates[pid],
    cfg,
    mode: modeState,
  });

  // Update mode state for next tick
  modeState = result.nextMode;

  // Execute decisions
  let executed = 0;
  for (const d of result.decisions) {
    try {
      if (d.kind === 'book') {
        await bookBid(fetcher, d.auctionId, d.count);
        executed++;
      } else if (d.kind === 'cancel') {
        await cancelBidBuddy(fetcher, d.auctionId);
        executed++;
      } else if (d.kind === 'exchange') {
        await exchangeWinForBids(fetcher, d.auctionId, d.orderId);
        executed++;
      }
      // 'alert' decisions are handled by the TUI directly
    } catch (e) {
      console.log(`bridge: decision ${d.kind} ${(d as { auctionId?: number }).auctionId ?? ''} failed: ${(e as Error).message}`);
    }
  }

  return { result, executed };
}
