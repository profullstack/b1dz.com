// @ts-nocheck
// Vendored from ~/src/dealdash/dealdash-ink.tsx. Strict types intentionally
// disabled — this file will be progressively refactored into typed React
// components under apps/cli/src/tui/dealdash/. Don't add new code here.
import { loadRootEnv } from '@b1dz/core';
loadRootEnv();
// CRITICAL: must run before importing ../dealdash/api.js, which auto-starts main() unless gated.
// Static ESM imports are hoisted, so we use a dynamic import below instead.
process.env.DEALDASH_NO_MAIN = '1';

// Capture all console.log calls into an in-memory ring buffer so they don't
// corrupt Ink's rendered output. The Logs panel renders the most recent.
const logBuffer: string[] = [];
const realLog = console.log;
import { appendFileSync as _append, statSync as _stat, renameSync as _rename, existsSync as _ex } from 'node:fs';
const LOG_FILE = '.dd.log';
const LOG_MAX_BYTES = 2 * 1024 * 1024;
let logWritesSinceCheck = 0;
function rotateIfNeeded() {
  if (++logWritesSinceCheck < 50) return;
  logWritesSinceCheck = 0;
  try {
    if (_ex(LOG_FILE) && _stat(LOG_FILE).size > LOG_MAX_BYTES) {
      _rename(LOG_FILE, LOG_FILE + '.1');
    }
  } catch {}
}
console.log = (...args: unknown[]) => {
  const line = args.map(a => typeof a === 'string' ? a.replace(/\x1B\[[0-9;]*m/g, '') : String(a)).join(' ');
  const stamped = `${new Date().toISOString()}  ${line}`;
  logBuffer.push(`${new Date().toLocaleTimeString()}  ${line}`);
  while (logBuffer.length > 200) logBuffer.shift();
  try { _append(LOG_FILE, stamped + '\n'); rotateIfNeeded(); } catch {}
};
process.on('exit', () => { console.log = realLog; });

import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useApp, useStdin } from 'ink';
import { MouseProvider, useOnClick, useMouse, useOnPress } from '@ink-tools/ink-mouse';
import TextInput from 'ink-text-input';
import type { DisplayAuction, AuctionInfo } from '../dealdash/api.js';
import {
  initBridge, pollTick, decideTick,
  getModeState, setLifeSavingMode, setExchangeableOnly, setStopLoss, setLockedProductIds,
  getFocusKeepId,
  type PollTickResult, type DecideTickResult,
} from './tui-bridge.js';
import {
  isPack as isPack_typed,
  type DealDashAuction,
  type MarketEntry as MarketEntry_typed,
  DEFAULT_STRATEGY,
} from '@b1dz/source-dealdash';

// Dynamic import — ensures DEALDASH_NO_MAIN is set before api.ts executes
const dd = await import('../dealdash/api.js');
const {
  getMyLiveAuctions, getAllLiveAuctions, getAuctionData, getBiddingHistory,
  getMyWins, getCostPerBid, getStoreBidPrice, fetchTitlesParallel, fetchCategoriesParallel, fetchAuctionPageInfo, exchangeWinForBids, fetchNotifications,
  bookBid, cancelBidBuddy, getBidders, toDisplay, isPack, packSizeFromTitle,
  refreshLifetimeIfStale, getLifetimeStats, bidsSpent, binCache, titleCache, categoryCache, exchangeableCache, productIdCache, noReEntryCache, exchangeRatesByProductId, USERNAME, AUTO_BID,
} = dd;

const POLL_MS = 5000;
const VALUESERP_KEY = process.env.VALUESERP_API_KEY || '';

// Cache market prices by title (ValueSERP results). Persisted to Supabase
// via state-sync — same per-user source_state.payload row as the others.
import { registerRecord, registerMap, registerObject, markDirty } from '../dealdash/state-sync.js';
const marketCache: Record<string, { min: number; median: number; mean?: number; count: number }> = {};
function saveMarket() { markDirty(); }
const marketInflight = new Set<string>();
registerRecord('marketPrices', marketCache);

// Background tracker: every auction we've ever seen in the live feed.
interface SeenAuction { id: number; title: string; bids: number; price: number; bin: number; firstSeen: number; lastSeen: number; ended: boolean; }
const seenAuctions: Map<number, SeenAuction> = new Map();
function saveSeen() { markDirty(); }
registerMap('seenAuctions', seenAuctions);
// Mirror of the current tick's locked title set so non-React helpers
// (profitability, MyAuctionsView) can read it.
let lockedTitlesGlobal = new Set<string>();

// Exchangeable-only mode: when on, we only bid on auctions where the item
// is exchangeable for bids — useful for grinding bid balance without taking
// physical delivery. Toggled with 'e'.
let exchangeableOnly = process.env.EXCHANGEABLE_ONLY === '1';

// Low-balance focus mode hysteresis: once we trip below LOW_BALANCE_ENTER
// we stay in focus mode until balance climbs back above LOW_BALANCE_EXIT.
// Without this gap, cancelling fights frees bids → balance rises → focus
// turns off → we open new fights → balance drops → flap.
let inLowBalanceMode = false;
// Manual override: force survival/acquire mode regardless of bid balance.
// Toggle with `l`. Same behavior as auto-trip below 1000, but stays on
// until the user explicitly turns it off.
let lifeSavingMode = process.env.LIFE_SAVING_MODE === '1';
// While in low-balance mode, only refill BidBuddy on this single auction.
// Set by the focus pass each tick; null when we're not focusing.
let focusKeepId: number | null = null;
// Same-product duplicates we should NOT bid on (DealDash's 30-day rebid
// lockout means winning one of them blocks all the others). Updated each
// tick by the waiting builder. Used by the AuctionRow renderer to dim
// these and prefix them with [DUP].
const duplicateAuctionIds = new Set<number>();
// Snipe mode: only enter NEW auctions in their final window (timer about to
// expire, no war in progress yet). Avoids long bidding fights entirely.
let snipeMode = process.env.SNIPE_MODE === '1';
const SNIPE_MAX_T = 60; // seconds remaining on the timer to consider entry

// Track which wins we've already auto-exchanged this session so we don't
// re-POST while waiting for the orders feed to reflect the change.
const autoExchangedIds = new Set<number>();

// In-app alerts strip — recent events shown below the totals row
type AlertLevel = 'good' | 'warn' | 'bad';
interface Alert { at: number; level: AlertLevel; text: string; }
const alerts: Alert[] = [];
function addAlert(level: AlertLevel, text: string) {
  alerts.push({ at: Date.now(), level, text });
  while (alerts.length > 8) alerts.shift();
  process.stdout.write('\x07'); // bell so tmux flags it
  console.log(`alert[${level}] ${text}`);
}

// Notifications we've already alerted on this session
const seenNotificationIds = new Set<string>();
let sessionExpiredAlerted = false;
// notificationCodes we don't want to surface (bid placement spam etc.).
// Anything NOT in this set gets through, including the useful warnings
// like bidbuddy_low / bidbuddy_empty / auction_won.
const BORING_NOTIFICATION_CODES = new Set<string>([
  'bid_placed', 'bid_booked', 'bidbuddy_low',
]);
function isBoringNotification(raw: Record<string, unknown>): boolean {
  const code = String(raw.notificationCode || '');
  return BORING_NOTIFICATION_CODES.has(code);
}

// Normalize a product title for lockout matching: lowercase, strip pack-size
// markers and punctuation, collapse whitespace.
function normalizeTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/^royalty only:\s*/i, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLocked(title: string): boolean {
  if (!title) return false;
  return lockedTitlesGlobal.has(normalizeTitle(title));
}

// Strip DealDash boilerplate that confuses ValueSERP
function cleanTitle(title: string): string {
  return title
    .replace(/^ROYALTY ONLY:\s*/i, '')
    .replace(/^Special\s+Blooming\s+Bargains\s*/i, '')
    .replace(/\s*-\s*Size\s+\d+\s*$/i, '')
    .trim();
}

async function fetchMarketPrice(title: string): Promise<void> {
  if (!VALUESERP_KEY) { console.log(`market: VALUESERP_API_KEY missing — "calc..." will never resolve`); return; }
  if (!title || marketCache[title] || marketInflight.has(title)) return;
  marketInflight.add(title);
  try {
    const cleaned = cleanTitle(title);
    const url = `https://api.valueserp.com/search?api_key=${VALUESERP_KEY}&search_type=shopping&q=${encodeURIComponent(cleaned.slice(0, 100))}&gl=us`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`market: ${res.status} ${res.statusText} for "${cleaned.slice(0, 50)}"`);
      return;
    }
    const data = await res.json() as { shopping_results?: { price_parsed?: { value?: number } }[] };
    const prices = (data.shopping_results || [])
      .map(r => r.price_parsed?.value)
      .filter((n): n is number => typeof n === 'number' && n > 0)
      .sort((a, b) => a - b);
    if (prices.length) {
      const min = prices[0];
      const median = prices[Math.floor(prices.length / 2)];
      const trim = Math.floor(prices.length * 0.2);
      const middle = prices.length > 4 ? prices.slice(trim, prices.length - trim) : prices;
      const mean = middle.reduce((s, n) => s + n, 0) / middle.length;
      marketCache[title] = { min, median, mean, count: prices.length };
      saveMarket();
    } else {
      marketCache[title] = { min: 0, median: 0, mean: 0, count: 0 };
      saveMarket();
    }
  } catch (e) {
    console.log(`market: error for "${title.slice(0, 50)}": ${(e as Error).message}`);
  } finally {
    marketInflight.delete(title);
  }
}
const REBID_BATCH = 5;
const REBID_CAP = 200;
const PACK_REBID_BATCH = 20;
const PACK_REBID_CAP = 400;
const PACK_CANCEL_THRESHOLD = 4;

interface State {
  loading: boolean;
  ts: string;
  bidBalance: number;
  costPerBid: number;
  storeBidPrice: number;
  myDisplay: DisplayAuction[];
  joinable: DisplayAuction[];
  waiting: DisplayAuction[];
  wins: { id: number; title: string; price: number; status: string; timestamp: number; exchanged: boolean; exchangedBids: number; orderId: string | null }[];
  lockedTitles: Set<string>;
  dailyNet: number;
  stopLoss: boolean;
  velocity: { spentPerMin: number; earnedPerMin: number };
  rates: { m1: number | null; m5: number | null; m15: number | null; m30: number | null; h1: number | null; d1: number | null; w1: number | null; mo1: number | null; y1: number | null };
  tightness: number;
  alerts: Alert[];
  lost: { id: number; title: string }[];
  stats: { s1: number; s2: number; s3: number; s4: number };
  totalLifetimeBids: number;
  totalLifetimeAuctions: number;
  totalBooked: number;
  totalSpent: number;
  myAuctionsCount: number;
  ddRevenueLive: number;
  ddPriceRevenueLive: number;
  ddBidsLive: number;
  ddAuctionsLive: number;
  ddCostLive: number;
  ddProfitLive: number;
  ddTotalAuctionsEver: number;
  ddTotalEnded: number;
  ddEverRevenue: number;
  ddEverCost: number;
  ddEverProfit: number;
}

const empty: State = {
  loading: true, ts: '', bidBalance: 0, costPerBid: 0.12, storeBidPrice: 0.15,
  myDisplay: [], joinable: [], waiting: [], wins: [], lost: [], lockedTitles: new Set(), dailyNet: 0, stopLoss: false, velocity: { spentPerMin: 0, earnedPerMin: 0 }, rates: { m1: null, m5: null, m15: null, m30: null, h1: null, d1: null, w1: null, mo1: null, y1: null }, tightness: 1.0, alerts: [],
  stats: { s1: 0, s2: 0, s3: 0, s4: 0 },
  totalLifetimeBids: 0, totalLifetimeAuctions: 0,
  totalBooked: 0, totalSpent: 0, myAuctionsCount: 0,
  ddRevenueLive: 0, ddPriceRevenueLive: 0, ddBidsLive: 0, ddAuctionsLive: 0,
  ddCostLive: 0, ddProfitLive: 0,
  ddTotalAuctionsEver: 0, ddTotalEnded: 0, ddEverRevenue: 0, ddEverCost: 0, ddEverProfit: 0,
};

async function tick(): Promise<State> {
  // --- Phase 3g: data-gathering via typed pollOnce + toDisplayAuctions ---
  const { poll: _poll, auctions: _typedAuctions } = await pollTick();

  // Hydrate vendored caches from pollOnce result so downstream UI code
  // (waiting tab, market lookup, seen-auctions tracker, etc.) still works.
  for (const [k, v] of Object.entries(_poll.caches.titles)) titleCache.set(Number(k), v);
  for (const [k, v] of Object.entries(_poll.caches.categories)) categoryCache.set(Number(k), v);
  for (const [k, v] of Object.entries(_poll.caches.bidsSpent)) bidsSpent.set(Number(k), v);
  for (const [k, v] of Object.entries(_poll.caches.bin)) binCache.set(Number(k), v);
  for (const [k, v] of Object.entries(_poll.caches.exchangeable)) exchangeableCache.set(Number(k), v);
  for (const [k, v] of Object.entries(_poll.caches.productIds)) productIdCache.set(Number(k), v);
  for (const [k, v] of Object.entries(_poll.caches.noReEntry)) noReEntryCache.set(Number(k), v);
  for (const [k, v] of Object.entries(_poll.caches.exchangeRates)) exchangeRatesByProductId.set(Number(k), v);

  // Alias pollOnce outputs to match the variable names downstream code expects
  const myIds = _poll.myIds;
  const allIds = _poll.allIds;
  const history = _poll.history;
  const wins = _poll.wins as { id: number; title: string; price: number; status: string; timestamp: number; exchanged: boolean; exchangedBids: number; orderId: string | null }[];
  const bidBalance = _poll.bidBalance;
  const allDetails = _poll.details;
  const info = _poll.info;
  const costPerBid = DEFAULT_STRATEGY.costPerBid;
  const storeBidPrice = DEFAULT_STRATEGY.storeBidPrice;

  // Keep vendored bidsSpent map in sync (authoritative from history)
  for (const h of history) {
    bidsSpent.set(h.auctionId, h.bidsPlaced);
  }

  // Refresh lifetime stats (TUI-specific, not in pollOnce)
  await refreshLifetimeIfStale();

  // Build allDisplay from vendored toDisplay for backward compat with UI components
  const myDetails = allDetails.filter(d => myIds.includes(d.auctionId));
  const allDisplay = myDetails.map(d => toDisplay(d, info));

  // Fire off ValueSERP lookups for any titles we haven't priced yet (rate-limited to 5 per tick)
  const needPricing = allDisplay.map(d => d.title).filter(t => t && !marketCache[t]).slice(0, 30);
  for (const t of needPricing) fetchMarketPrice(t); // fire-and-forget

  const joinDetails = allDetails.filter(d => {
    const n = getBidders(d.history).length;
    return n <= 2 && !d.noNewBidders && !myIds.includes(d.auctionId);
  });
  await fetchTitlesParallel(joinDetails.slice(0, 30).map(d => d.auctionId));
  const joinable = joinDetails.slice(0, 30).map(d => toDisplay(d, info));

  const visible = allDisplay.filter(d => d.bidsBooked > 0 || d.bidders <= 2);
  // Waiting tab: show every auction we've sunk bids into where our queue is
  // currently empty. Includes auctions DealDash no longer lists under "my
  // auctions" because we cancelled BidBuddy — those still live in
  // `allDetails` (the global live feed) and we use `bidsSpent` as the
  // ground-truth of "we have a stake in this".
  const waitingMap = new Map<number, DisplayAuction>();
  // First pass: my own live auctions. Show ALL of them, including ones
  // currently classified as 'loss' — the user wants visibility on every
  // stake, the rejoin sort puts the best ones first anyway.
  for (const d of allDisplay) {
    const placed = (bidsSpent.get(d.id) || 0) > 0;
    const inHist = (myDetails.find(x => x.auctionId === d.id)?.history || []).some(h => h[2] === USERNAME);
    if (!(placed || inHist)) continue;
    if (d.bidsBooked > 0) continue;
    waitingMap.set(d.id, d);
  }
  // Second pass: anything we've spent bids on that's still live in the
  // global feed, even if DealDash no longer lists it under our auctions
  for (const det of allDetails) {
    const id = det.auctionId;
    if (waitingMap.has(id)) continue;
    if ((bidsSpent.get(id) || 0) <= 0) continue;
    const display = toDisplay(det, info);
    if (display.bidsBooked > 0) continue;
    waitingMap.set(id, display);
  }
  // Sort by "next to jump back in" — same scoring as the auto-bid focus
  // mode: packs always beat non-packs, then within each group highest
  // (profit per bidder) wins.
  function rejoinScore(d: DisplayAuction): { pack: boolean; score: number } {
    const spent$ = d.bidsSpent * costPerBid + Number(d.ddPrice || 0);
    const pack = isPack(d.id);
    // sqrt penalty for bidder count — a 5-way is ~1.6x harder than a 2-way,
    // not 2.5x. Big upside still wins.
    const competition = Math.sqrt(Math.max(1, d.bidders));
    if (pack) {
      const sz = packSizeFromTitle(d.title) || 1;
      const effPerBid = spent$ / sz;
      // Total marginal upside in dollars (not per-bid) so a 9682 pack at
      // $0.003/b ranks above a 700 pack at $0.001/b — pack size matters.
      const totalUpside = (storeBidPrice - effPerBid) * sz;
      return { pack: true, score: totalUpside / competition };
    }
    const v = getResaleValue(d, storeBidPrice);
    const projected = v ? v.value - spent$ : 0;
    return { pack: false, score: projected / competition };
  }
  // Mark same-product duplicates: among any group of waiting auctions with
  // the same productId, the one with the most bidsSpent is the "winner"
  // (sunk cost preservation), all others get flagged as duplicates so the
  // UI can render them as "Skipped/dup" without actually hiding them.
  duplicateAuctionIds.clear();
  {
    const byPid = new Map<number, { id: number; spent: number }>();
    for (const d of waitingMap.values()) {
      const pid = productIdCache.get(d.id);
      if (!pid) continue;
      const prev = byPid.get(pid);
      if (!prev || d.bidsSpent > prev.spent) byPid.set(pid, { id: d.id, spent: d.bidsSpent });
    }
    for (const d of waitingMap.values()) {
      const pid = productIdCache.get(d.id);
      if (!pid) continue;
      const winner = byPid.get(pid);
      if (winner && winner.id !== d.id) duplicateAuctionIds.add(d.id);
    }
  }

  const waiting = [...waitingMap.values()].sort((a, b) => {
    // Duplicates always go to the bottom — they're informational only
    const da = duplicateAuctionIds.has(a.id);
    const db = duplicateAuctionIds.has(b.id);
    if (da !== db) return da ? 1 : -1;
    const sa = rejoinScore(a);
    const sb = rejoinScore(b);
    if (sa.pack !== sb.pack) return sa.pack ? -1 : 1;
    return sb.score - sa.score;
  });

  // --- Phase 3g: strategy + execution via typed decide() ---
  // Sync TUI toggle state → bridge mode state so decide() sees the latest
  setLifeSavingMode(lifeSavingMode);
  setExchangeableOnly(exchangeableOnly);
  setStopLoss(stopLossTripped);

  if (AUTO_BID) {
    // Build the full typed auction list (my + joinable) for decide()
    const allTyped = _typedAuctions;
    const { result: decisionResult, executed: _execCount } = await decideTick(_poll, allTyped);

    // Propagate focus + duplicates back to the TUI globals for rendering
    focusKeepId = decisionResult.focusKeepId;
    duplicateAuctionIds.clear();
    for (const id of decisionResult.duplicates) duplicateAuctionIds.add(id);
    inLowBalanceMode = decisionResult.nextMode.balance.inLow;

    // Log alert-type decisions
    for (const d of decisionResult.decisions) {
      if (d.kind === 'alert') addAlert(d.level === 'info' ? 'warn' : d.level, d.text);
      if (d.kind === 'cancel') recordExit(d.auctionId, d.reason);
    }
  }

  // #9 Velocity: sample tick-over-tick bid balance delta + exchange earnings
  const exchangedTotal = wins.filter(w => w.exchanged).reduce((s, w) => s + w.exchangedBids, 0);
  if (lastBalanceForVelocity > 0) {
    const spent = Math.max(0, lastBalanceForVelocity - bidBalance);
    const earned = Math.max(0, exchangedTotal - lastExchangedTotalForVelocity);
    pushVelocity(spent, earned);
  }
  lastBalanceForVelocity = bidBalance;
  lastExchangedTotalForVelocity = exchangedTotal;

  // Daily P/L update: count today's wins + exchanges, compute net vs bids spent.
  // costPerBid × bids spent today is roughly the spend; bid value gained from
  // exchanges + resale value of physical wins is the gain.
  if (dailyPL.date !== todayKey()) {
    dailyPL = { date: todayKey(), startingBids: bidBalance, spentBids: 0, gainedValue: 0 };
  }
  if (dailyPL.startingBids === 0) dailyPL.startingBids = bidBalance;
  dailyPL.spentBids = Math.max(0, dailyPL.startingBids - bidBalance);
  let gained = 0;
  for (const w of wins) {
    if ((w.timestamp || 0) * 1000 < Date.now() - 86_400_000) continue;
    if (w.exchanged) gained += w.exchangedBids * storeBidPrice;
    else {
      const market = marketCache[w.title] || marketCache[cleanTitle(w.title)];
      const sell = market && market.count > 0 ? (market.mean ?? market.median ?? market.min) : 0;
      if (sell) gained += sell - w.price;
    }
  }
  dailyPL.gainedValue = gained;
  savePL(dailyPL);
  const dailyNet = dailyPL.gainedValue - dailyPL.spentBids * costPerBid;
  // Track rolling sample for hour/day/week/month rates
  pushSample(dailyNet);
  const rates = {
    m1:   netOver(60_000, dailyNet),
    m5:   netOver(5 * 60_000, dailyNet),
    m15:  netOver(15 * 60_000, dailyNet),
    m30:  netOver(30 * 60_000, dailyNet),
    h1:   netOver(60 * 60_000, dailyNet),
    d1:   netOver(24 * 60 * 60_000, dailyNet),
    w1:   netOver(7 * 24 * 60 * 60_000, dailyNet),
    mo1:  netOver(30 * 24 * 60 * 60_000, dailyNet),
    y1:   netOver(365 * 24 * 60 * 60_000, dailyNet),
  };

  // Auto-tune strategy based on recent performance. We look at the windows
  // that have settled (m5 / m15 / m30 / h1) and count how many are negative.
  // More negatives → tighten gates. More positives → loosen.
  const trendWindows = [rates.m5, rates.m15, rates.m30, rates.h1].filter((v): v is number => v != null);
  const negatives = trendWindows.filter(v => v < 0).length;
  const positives = trendWindows.filter(v => v > 0).length;
  // tightnessMultiplier > 1 = more conservative; < 1 = looser
  if (trendWindows.length >= 2) {
    if (negatives >= 3) tightnessMultiplier = 1.5;       // bleeding — tighten hard
    else if (negatives === 2) tightnessMultiplier = 1.25; // mild trouble
    else if (positives >= 3) tightnessMultiplier = 0.8;   // winning — loosen
    else tightnessMultiplier = 1.0;                       // neutral
  }
  if (dailyNet < DAILY_STOP_LOSS && !stopLossTripped) {
    stopLossTripped = true;
    addAlert('bad', `🛑 STOP-LOSS TRIPPED: daily net $${dailyNet.toFixed(2)} < $${DAILY_STOP_LOSS} — AUTO_BID paused`);
  }

  // Session expiry detection: getMyLiveAuctions sets a flag on 401/403.
  // Surface it as a red alert and pause AUTO_BID until you log back in.
  if ((dd as { sessionExpired?: boolean }).sessionExpired && !sessionExpiredAlerted) {
    sessionExpiredAlerted = true;
    addAlert('bad', `🔒 SESSION EXPIRED — log into DealDash again and update DEALDASH_COOKIE in .env`);
  }

  // Poll DealDash notifications. Alert (terminal bell + log) on any new
  // entry that isn't bid-placement spam.
  try {
    const notifs = await fetchNotifications();
    for (const n of notifs) {
      const key = String(n.id);
      if (seenNotificationIds.has(key)) continue;
      seenNotificationIds.add(key);
      const raw = n.raw as Record<string, unknown>;
      if (isBoringNotification(raw)) continue;
      const code = String(raw.notificationCode || '');
      const aid = String(raw.auctionId || '');
      const link = aid && /^\d+$/.test(aid) ? `  https://www.dealdash.com/auction/${aid}` : '';
      const cleanText = String(raw.plainText || raw.title || n.text);
      const isLowOrEmpty = /no\s+bids?\s+left|booked\s+bids?\s+left|bidbuddy_(low|empty|out)/i.test(`${cleanText} ${code}`);
      addAlert(isLowOrEmpty ? 'bad' : 'warn', `${isLowOrEmpty ? '⚠️ ' : '🔔'} ${cleanText}${link}`);
    }
  } catch (e) {
    console.log(`notifications error: ${(e as Error).message}`);
  }

  // Augment wins from history: any history entry with status === 'Won' that
  // isn't in the orders feed yet. Scrape the auction page to get title +
  // exchange info (exchangedAt / exchangedFor).
  const winIds = new Set(wins.map(w => w.id));
  const wonFromHistory = history.filter(h => h.status === 'Won' && !winIds.has(h.auctionId));
  await Promise.all(wonFromHistory.slice(0, 10).map(async h => {
    const info = await fetchAuctionPageInfo(h.auctionId);
    if (!info) return;
    const exchanged = !!info.exchangedAt;
    wins.push({
      id: h.auctionId,
      title: info.name || h.productName || '',
      price: 0,
      status: exchanged ? 'Exchanged' : 'Won',
      timestamp: info.exchangedAt || h.timestamp,
      exchanged,
      exchangedBids: info.exchangedFor || 0,
      orderId: null,
    });
  }));

  // Auto-exchange: in ExchangeOnly mode, convert any unexchanged
  // exchangeable win into bids automatically. Once-per-id guard so we
  // don't spam the API while the orders feed catches up.
  if (exchangeableOnly) {
    for (const w of wins) {
      if (w.exchanged) continue;
      if (!w.orderId) continue;
      if (autoExchangedIds.has(w.id)) continue;
      // Need to know the auction is exchangeable. Scrape page info if missing.
      let exable = exchangeableCache.get(w.id);
      if (exable === undefined) {
        const pi = await fetchAuctionPageInfo(w.id);
        exable = pi?.exchangeable;
      }
      if (exable !== true) continue;
      autoExchangedIds.add(w.id);
      console.log(`auto-exchange ${w.id} (order ${w.orderId}): ${w.title}`);
      const result = await exchangeWinForBids(w.id, w.orderId);
      if (result === 'ok') {
        w.exchanged = true;
      } else if (result === 'transient-fail') {
        // Allow retry next tick — likely a network or 5xx blip
        autoExchangedIds.delete(w.id);
      }
      // permanent-fail: keep id in autoExchangedIds so we never retry it
    }
  }

  // Also re-scrape exchange info for orders-feed wins so we catch ones that
  // were exchanged AFTER the orders endpoint reported the original win.
  await Promise.all(wins.filter(w => !w.exchanged).slice(0, 10).map(async w => {
    const info = await fetchAuctionPageInfo(w.id);
    if (info?.exchangedAt) {
      w.exchanged = true;
      w.exchangedBids = info.exchangedFor || 0;
    }
  }));

  // 30-day lockout: DealDash blocks rebids on any product you've recently won.
  // Build a normalized title set from wins in the last 30 days.
  const LOCKOUT_DAYS = 30;
  const lockoutCutoff = Date.now() - LOCKOUT_DAYS * 86_400_000;
  const lockedTitles = new Set<string>();
  for (const w of wins) {
    if ((w.timestamp || 0) * 1000 >= lockoutCutoff) lockedTitles.add(normalizeTitle(w.title));
    if (!seenWinForHour.has(w.id)) {
      seenWinForHour.add(w.id);
      bumpHour('wins');
      addAlert('good', `🏆 WON ${w.id} — ${w.title}${w.exchanged ? ` (exchanged for ${w.exchangedBids} bids)` : ''}`);
      // Fire-and-forget: scrape the win-payment page to learn the bid
      // exchange rate for this product, so future identical-product
      // auctions can be priced without re-winning.
      void dd.fetchWinPaymentExchangeRate(w.id).then((bids) => {
        if (bids != null) console.log(`exchange rate learned: auction ${w.id} = ${bids} bids`);
      });
    }
  }
  for (const l of history.filter(h => h.status === 'Sold' || h.status === 'Lost')) {
    if (!seenLossForHour.has(l.auctionId)) {
      seenLossForHour.add(l.auctionId);
      bumpHour('losses');
      addAlert('bad', `✗ lost ${l.auctionId} — ${l.productName}`);
    }
  }
  lockedTitlesGlobal = lockedTitles;

  const winSet = new Set(wins.map(w => w.id));
  const dedupedWins = Array.from(new Map(wins.map(w => [w.id, w])).values());
  const lostMap = new Map<number, { id: number; title: string }>();
  for (const h of history) {
    if (h.status === 'Sold' && !winSet.has(h.auctionId)) {
      lostMap.set(h.auctionId, { id: h.auctionId, title: h.productName });
    }
  }
  const lost = Array.from(lostMap.values());

  const allCounts = allDetails.map(d => getBidders(d.history).length);
  const stats = {
    s1: allCounts.filter(n => n === 1).length,
    s2: allCounts.filter(n => n === 2).length,
    s3: allCounts.filter(n => n === 3).length,
    s4: allCounts.filter(n => n >= 4).length,
  };

  // Pull BIN prices for the entire live feed (not just MY auctions) so we can compute DD's cost basis
  await fetchTitlesParallel(allDetails.map(d => d.auctionId));

  // DealDash revenue snapshot — sum of all bids × store rate across the live feed
  // (this is just what we can see right now, not lifetime)
  const totalBidsLive = allDetails.reduce((s, d) => s + (info.get(d.auctionId)?.x || 0), 0);
  const revenueLive = totalBidsLive * storeBidPrice;
  const totalPriceLive = allDetails.reduce((s, d) => s + Number(info.get(d.auctionId)?.r || 0), 0);
  const totalCostLive = allDetails.reduce((s, d) => s + (binCache.get(d.auctionId) || 0), 0);
  const profitLive = revenueLive + totalPriceLive - totalCostLive;

  // Background tracker — record/update everything we've seen
  const liveIds = new Set(allDetails.map(d => d.auctionId));
  const now = Date.now();
  for (const d of allDetails) {
    const inf = info.get(d.auctionId);
    const existing = seenAuctions.get(d.auctionId);
    seenAuctions.set(d.auctionId, {
      id: d.auctionId,
      title: titleCache.get(d.auctionId) || existing?.title || '',
      bids: inf?.x || existing?.bids || 0,
      price: Number(inf?.r || existing?.price || 0),
      bin: binCache.get(d.auctionId) || existing?.bin || 0,
      firstSeen: existing?.firstSeen || now,
      lastSeen: now,
      ended: false,
    });
  }
  // Mark anything we've seen before but not in this tick as ended
  for (const [id, s] of seenAuctions) {
    if (!liveIds.has(id) && !s.ended) {
      s.ended = true;
      seenAuctions.set(id, s);
    }
  }
  saveSeen();
  // Lifetime totals across everything ever seen (live + ended)
  let everRev = 0, everCost = 0, ended = 0;
  for (const s of seenAuctions.values()) {
    everRev += s.bids * storeBidPrice + s.price;
    everCost += s.bin;
    if (s.ended) ended++;
  }
  const everProfit = everRev - everCost;

  const myInfos = [...info.values()].filter(a => myIds.includes(a.i));
  const totalBooked = myInfos.reduce((s, a) => s + (a.bb?.c || 0), 0);
  const totalSpent = [...bidsSpent.values()].reduce((s, v) => s + v, 0);
  const lifetime = getLifetimeStats();

  return {
    loading: false,
    ts: new Date().toLocaleTimeString(),
    bidBalance, costPerBid, storeBidPrice,
    myDisplay: visible,
    joinable,
    waiting,
    wins: dedupedWins,
    lockedTitles,
    dailyNet,
    stopLoss: stopLossTripped,
    velocity: getVelocity(),
    rates,
    tightness: tightnessMultiplier,
    alerts: [...alerts],
    lost,
    stats,
    totalLifetimeBids: lifetime.bids,
    totalLifetimeAuctions: lifetime.auctions,
    totalBooked,
    totalSpent,
    myAuctionsCount: myIds.length,
    ddRevenueLive: revenueLive,
    ddPriceRevenueLive: totalPriceLive,
    ddBidsLive: totalBidsLive,
    ddAuctionsLive: allDetails.length,
    ddCostLive: totalCostLive,
    ddProfitLive: profitLive,
    ddTotalAuctionsEver: seenAuctions.size,
    ddTotalEnded: ended,
    ddEverRevenue: everRev,
    ddEverCost: everCost,
    ddEverProfit: everProfit,
  };
}

const TABS = ['My', '1v1', 'Profit', 'Loss', 'Waiting', 'Joinable', 'Won', 'Lost', 'Arb', 'Trade', 'Lookup', 'Logs'] as const;

const MIN_PROFIT = Number(process.env.MIN_PROFIT || '20');

// Compute the resale value for an auction. For bid packs we use the store rate
// (pack_size × store_bid_price); for everything else we use ValueSERP min.
// Returns null if value can't be determined yet.
function getResaleValue(a: DisplayAuction, storeBidPrice: number): { value: number; source: 'pack' | 'market' } | null {
  if (isPack(a.id)) {
    const size = packSizeFromTitle(a.title);
    if (size > 0) return { value: size * storeBidPrice, source: 'pack' };
    return null; // can't parse pack size
  }
  const market = a.title ? marketCache[a.title] : undefined;
  if (!market || market.count === 0) return null;
  // Prefer trimmed mean (robust to junk listings); fall back to median for
  // legacy cache entries written before we tracked mean.
  const value = market.mean ?? market.median ?? market.min;
  return { value, source: 'market' };
}

function profitability(a: DisplayAuction, costPerBid: number, storeBidPrice: number): 'profit' | 'loss' | 'unknown' {
  // Art: titles are too generic to price reliably for resale — but if it's
  // exchangeable, we can flip it for bids and skip the resale problem.
  if (isArtCategory(a.id) && exchangeableCache.get(a.id) !== true) return 'loss';
  // 30-day lockout: we already won this product recently and DealDash won't
  // let us win it again, so any bids burned here are wasted.
  if (isLocked(a.title)) return 'loss';
  // Bid pack: compute from pack size × store rate
  if (isPack(a.id)) {
    const v = getResaleValue(a, storeBidPrice);
    if (!v) return 'unknown';
    const spent = a.bidsSpent * costPerBid + Number(a.ddPrice || 0);
    return v.value - spent >= MIN_PROFIT ? 'profit' : 'loss';
  }
  // Non-pack: use ValueSERP cache. Non-packs require a much higher floor
  // ($100) — anything less isn't worth the bid burn.
  const market = a.title ? marketCache[a.title] : undefined;
  if (!market) return 'unknown';
  if (market.count === 0) return 'loss';
  const value = market.mean ?? market.median ?? market.min;
  const spent = a.bidsSpent * costPerBid + Number(a.ddPrice || 0);
  const floor = nonPackMinProfit(a.bidders);
  return value - spent >= floor ? 'profit' : 'loss';
}

const NONPACK_MIN_PROFIT_BASE = Number(process.env.MIN_PROFIT_BASE || '500');
// Profit floor for ENTRY: scaled by bidder count. Wars are expensive so we
// demand more headroom before opening a new front.
function nonPackEntryFloor(bidders: number): number {
  return NONPACK_MIN_PROFIT_BASE + Math.max(0, bidders - 1) * 50;
}
// Profit floor for REBOOK on auctions we're already in. Low-ish because
// sunk cost is real — losing means burning everything we've spent so far.
// But not too low: we want to abandon marginal fights so the bid pool can
// fund the high-upside ones.
const NONPACK_REBOOK_FLOOR_BASE = Number(process.env.REBOOK_FLOOR || '500');
// Auto-tuned each tick from recent P/L trend (see auto-tune block in tick).
// >1 = tighter (raise floors, lower concurrency), <1 = looser.
let tightnessMultiplier = 1.0;
const NONPACK_REBOOK_FLOOR_DYNAMIC = () => Math.round(NONPACK_REBOOK_FLOOR_BASE * tightnessMultiplier);
// Backwards-compat const used inside the rebook block — replaced with the
// dynamic getter below in the actual checks.
// Read this at gate-evaluation time (not at module load) so the auto-tuned
// multiplier from the previous tick takes effect immediately.
function rebookFloor(): number { return NONPACK_REBOOK_FLOOR_DYNAMIC(); }
// Backwards-compat alias used by profitability() — uses entry floor since
// that controls auto-cancel + new bookings (not rebooks).
function nonPackMinProfit(bidders: number): number {
  return nonPackEntryFloor(bidders);
}

// Bidder skip list: usernames we never want to fight. Comma-separated env.
const SKIP_BIDDERS = new Set(
  (process.env.SKIP_BIDDERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
);
function hasBlockedBidder(d: DisplayAuction): boolean {
  if (!SKIP_BIDDERS.size) return false;
  const myName = (USERNAME || '').toLowerCase();
  // d.history isn't available — use the live username (`w`) check via info if needed
  // We instead check via the auctionInfo.w (current winner) at call sites.
  return false;
}

// Bid balance floor — never let our reserve drop below this when entering
// new auctions. Rebooks ignore the floor (we're already committed there).
const BID_BALANCE_FLOOR = Number(process.env.BID_BALANCE_FLOOR || '50');

// Concurrency cap: don't enter new auctions if we're already in this many.
// Each active fight pulls from the same bid pool — too many fronts and we
// starve every one of them.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || '5');

// Product cooldown: only commit to ONE auction per productId per tick — the
// one with the lowest current total bids placed (cheapest = least
// competition). Recomputed each tick from the current snapshot rather than
// stuck on whichever auction we happened to see first.
let productPick = new Map<number, number>(); // productId → chosen auctionId for this tick

// Stop-loss: if today's net (from .dd-pl.json) drops below this, AUTO_BID
// is paused for the rest of the day.
const DAILY_STOP_LOSS = Number(process.env.DAILY_STOP_LOSS || '-50');
let stopLossTripped = false;

// Daily P/L: snapshot bids spent + value gained at session start, compute
// delta each tick. Persisted to Supabase via state-sync.
interface DailyPL { date: string; startingBids: number; spentBids: number; gainedValue: number; }
function todayKey(): string { return new Date().toISOString().slice(0, 10); }
function savePL(_p: DailyPL) { markDirty(); }
// #7 Loss postmortem: record why we exited each auction so the Lost tab can
// explain what went wrong. Keyed by auctionId.
const exitReason = new Map<number, string>();
function recordExit(id: number, reason: string) {
  exitReason.set(id, reason);
  console.log(`exit ${id}: ${reason}`);
}

// #1 Time-of-day stats: per-hour wins/losses, persisted to Supabase via state-sync
interface HourStats { wins: number; losses: number; }
const hourStats: Record<number, HourStats> = {};
registerRecord('hourStats', hourStats);
function bumpHour(field: 'wins' | 'losses') {
  const h = new Date().getHours();
  if (!hourStats[h]) hourStats[h] = { wins: 0, losses: 0 };
  hourStats[h][field]++;
  markDirty();
}
const seenWinForHour = new Set<number>();
const seenLossForHour = new Set<number>();

// #9 Bid velocity: rolling 10-minute window of bids spent vs bids earned
interface VelocityEvent { at: number; spent: number; earned: number; }
const velocityEvents: VelocityEvent[] = [];
function pushVelocity(spent: number, earned: number) {
  velocityEvents.push({ at: Date.now(), spent, earned });
  const cutoff = Date.now() - 10 * 60_000;
  while (velocityEvents.length && velocityEvents[0].at < cutoff) velocityEvents.shift();
}
function getVelocity(): { spentPerMin: number; earnedPerMin: number } {
  const cutoff = Date.now() - 10 * 60_000;
  let spent = 0, earned = 0;
  for (const e of velocityEvents) { if (e.at >= cutoff) { spent += e.spent; earned += e.earned; } }
  return { spentPerMin: spent / 10, earnedPerMin: earned / 10 };
}

let lastBalanceForVelocity = 0;
let lastExchangedTotalForVelocity = 0;

let dailyPL: DailyPL = { date: todayKey(), startingBids: 0, spentBids: 0, gainedValue: 0 };
registerObject<DailyPL>('dailyPL', () => dailyPL, (v) => { if (v && v.date === todayKey()) dailyPL = v; });

// Rolling P/L samples — one per tick. Used to compute net change over the
// last 1m/5m/15m/30m/1h/1d/1w/1mo/1y windows. Persisted via state-sync.
interface PLSample { at: number; net: number; }
const plSamples: PLSample[] = [];
registerObject<PLSample[]>('plSamples', () => plSamples, (v) => { if (Array.isArray(v)) plSamples.push(...v); });
function pushSample(net: number) {
  plSamples.push({ at: Date.now(), net });
  // Trim to 30 days × 1 sample per minute = 43200 max
  const cutoff = Date.now() - 30 * 86_400_000;
  while (plSamples.length && plSamples[0].at < cutoff) plSamples.shift();
  // Mark dirty every 12 samples (~1 minute at 5s tick) so state-sync flushes it
  if (plSamples.length % 12 === 0) markDirty();
}
/** Net change over the last `windowMs`. Returns null if we don't have a
 *  baseline old enough yet. */
function netOver(windowMs: number, currentNet: number): number | null {
  const cutoff = Date.now() - windowMs;
  // Find the oldest sample within the window — that's our baseline
  const baseline = plSamples.find(s => s.at >= cutoff);
  if (!baseline) return null;
  return currentNet - baseline.net;
}
type Tab = typeof TABS[number];

function Header({ s }: { s: State }) {
  const lowBalance = s.bidBalance < 5;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">🎯 DealDash Auction Monitor 🎯  {s.loading ? '(loading...)' : s.ts}  AutoBid: <Text color={AUTO_BID ? 'green' : 'gray'}>{AUTO_BID ? 'ON' : 'OFF'}</Text>  ExchangeOnly: <Text color={exchangeableOnly ? 'yellow' : 'gray'}>{exchangeableOnly ? 'ON' : 'OFF'}</Text>  Snipe: <Text color={snipeMode ? 'yellow' : 'gray'}>{snipeMode ? 'ON' : 'OFF'}</Text>  LifeSaving: <Text color={lifeSavingMode ? 'red' : 'gray'} bold={lifeSavingMode}>{lifeSavingMode ? 'ON' : 'OFF'}</Text></Text>
      <Text>
        💰 Balance: <Text bold color={lowBalance ? 'red' : 'cyan'}>{s.bidBalance}</Text> bids
        {'  |  '}📌 Booked: <Text bold color="green">{s.totalBooked}</Text> across {s.myAuctionsCount} auctions
        {'  |  '}💸 Spent: <Text bold color="magenta">{s.totalSpent}</Text> bids
      </Text>
      <Text color="gray">
        📜 Lifetime: <Text bold color="magenta">{s.totalLifetimeBids}</Text> bids across <Text bold>{s.totalLifetimeAuctions}</Text> auctions  (${(s.totalLifetimeBids * s.costPerBid).toFixed(2)} at ${s.costPerBid.toFixed(3)}/bid, store ${s.storeBidPrice.toFixed(2)})
      </Text>
      <Text color="gray">
        📊 Live feed —  1 bidder: <Text color="green" bold>{s.stats.s1}</Text>{'  '}
        2: <Text color="cyan" bold>{s.stats.s2}</Text>{'  '}
        3: <Text color="yellow" bold>{s.stats.s3}</Text>{'  '}
        4+: <Text color="red" bold>{s.stats.s4}</Text>
      </Text>
      <Text color="gray">
        💵 DealDash live ({s.ddAuctionsLive}):  rev <Text bold color="green">${(s.ddRevenueLive + s.ddPriceRevenueLive).toFixed(0)}</Text>  −  cost <Text bold color="red">${s.ddCostLive.toFixed(0)}</Text>  =  <Text bold color={s.ddProfitLive >= 0 ? 'green' : 'red'}>{s.ddProfitLive >= 0 ? '+' : '-'}${Math.abs(s.ddProfitLive).toFixed(0)}</Text>
      </Text>
      <Text color="gray">
        📈 Tracked across {s.ddTotalAuctionsEver} auctions ({s.ddTotalEnded} ended):  rev <Text bold color="green">${s.ddEverRevenue.toFixed(0)}</Text>  −  cost <Text bold color="red">${s.ddEverCost.toFixed(0)}</Text>  =  <Text bold color={s.ddEverProfit >= 0 ? 'green' : 'red'}>{s.ddEverProfit >= 0 ? '+' : '-'}${Math.abs(s.ddEverProfit).toFixed(0)}</Text>
      </Text>
      {lowBalance && <Text bold color="white" backgroundColor="red"> ⚠️  OUT OF BIDS — buy more at https://www.dealdash.com/buy-bids ⚠️ </Text>}
      {s.stopLoss && <Text bold color="white" backgroundColor="red"> 🛑 STOP-LOSS — AUTO_BID PAUSED </Text>}
    </Box>
  );
}

function TabButton({ tab, active, count, onSelect }: { tab: Tab; active: boolean; count: number; onSelect: (t: Tab) => void }) {
  const ref = useRef(null);
  useOnClick(ref, () => onSelect(tab));
  return (
    <Box ref={ref} marginRight={1}>
      <Text
        color={active ? 'black' : 'white'}
        backgroundColor={active ? 'cyan' : undefined}
        bold={active}
      >
        {` ${tab} (${count}) `}
      </Text>
    </Box>
  );
}

function TabBar({ active, onSelect, counts }: { active: Tab; onSelect: (t: Tab) => void; counts: Record<Tab, number> }) {
  const mouse = useMouse();
  // Mouse tracking disabled — clicks don't work anyway and the escape codes
  // leak garbage into TextInput on the Lookup tab.
  useEffect(() => {
    if (mouse.isEnabled) mouse.disable();
  }, [mouse.isEnabled]);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {TABS.map(t => (
          <TabButton key={t} tab={t} active={t === active} count={counts[t]} onSelect={onSelect} />
        ))}
      </Box>
      <Text color="gray">
        🖱  click tabs, ←/→ arrows, or 1-6  {!mouse.isEnabled && <Text color="red">[mouse off]</Text>}
      </Text>
    </Box>
  );
}

function AuctionRow({ a, showSpent, costPerBid, storeBidPrice, selected, catWidth = 14 }: { a: DisplayAuction; showSpent?: boolean; costPerBid: number; storeBidPrice: number; selected?: boolean; catWidth?: number }) {
  const bidColor: 'red' | 'yellow' | 'gray' =
    a.bidders <= 2 ? 'red' : a.bidders <= 4 ? 'yellow' : 'gray';
  const spent$ = (a.bidsSpent * costPerBid + Number(a.ddPrice || 0));
  const resale = getResaleValue(a, storeBidPrice);
  const noResults = !isPack(a.id) && a.title ? (marketCache[a.title]?.count === 0) : false;
  const sell$ = resale?.value || 0;
  const profit = resale ? sell$ - spent$ : 0;
  const profitColor: 'green' | 'red' | 'gray' =
    !resale && !noResults ? 'gray' : noResults ? 'red' : profit > 0 ? 'green' : 'red';
  const bg = selected ? '#121212' : undefined;
  const sellText = !resale && !noResults ? 'calc...' : noResults ? 'no match' : `$${sell$.toFixed(0)}`;
  const pack = isPack(a.id);
  const packSize = pack ? packSizeFromTitle(a.title) : 0;
  // For packs we display the effective cost-per-bid (total spend / pack size)
  // instead of profit. Color: green ≤ $0.03, yellow ≤ $0.05, red > $0.05.
  const packPerBid = pack && packSize > 0 ? spent$ / packSize : 0;
  const packPerBidColor: 'green' | 'yellow' | 'red' | 'gray' =
    !pack ? 'gray' : packPerBid <= 0.03 ? 'green' : packPerBid <= 0.05 ? 'yellow' : 'red';
  const packPerBidText = pack ? (packSize > 0 ? `$${packPerBid.toFixed(3)}/b` : 'no size') : '';
  // For exchangeable non-pack items, show the bid exchange offer if we've
  // learned it from a previous win of the same product. Falls back to the
  // resale-profit display when we haven't seen this product yet.
  const pid = productIdCache.get(a.id);
  const exchRate = pid ? exchangeRatesByProductId.get(pid) : undefined;
  const isExchangeable = exchangeableCache.get(a.id) === true;
  const showExchangeRate = !pack && isExchangeable && exchRate != null;
  const exchPerBid = showExchangeRate && exchRate ? spent$ / exchRate : 0;
  const exchPerBidColor: 'green' | 'yellow' | 'red' =
    exchPerBid <= 0.03 ? 'green' : exchPerBid <= 0.05 ? 'yellow' : 'red';

  const profitText = pack
    ? packPerBidText
    : showExchangeRate
      ? `${exchRate}b @ $${exchPerBid.toFixed(3)}/b`
      : (!resale && !noResults ? 'calc...' : noResults ? 'no match' : (profit > 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`));
  const profitCellColor = pack
    ? packPerBidColor
    : showExchangeRate
      ? exchPerBidColor
      : profitColor;
  const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
  return (
    <Box>
      <Text color={selected ? 'yellow' : 'red'} backgroundColor={bg} bold>{pad(selected ? '[x]' : ' x ', 4)}</Text>
      <Text color={bidColor} backgroundColor={bg} bold>{pad(a.bidders, 4)}</Text>
      <Text color="cyan" backgroundColor={bg}>{pad(`$${a.ddPrice}`, 9)}</Text>
      <Text color={a.bidsBooked > 0 ? 'green' : 'gray'} backgroundColor={bg}>{pad(a.bidsBooked, 8)}</Text>
      {showSpent && (
        <Text color={a.bidsSpent > 0 ? 'magenta' : 'gray'} backgroundColor={bg}>{pad(a.bidsSpent, 7)}</Text>
      )}
      <Text color="gray" backgroundColor={bg}>{pad(a.totalBids, 8)}</Text>
      <Text color="magenta" backgroundColor={bg}>{pad(`$${spent$.toFixed(2)}`, 9)}</Text>
      <Text color="cyan" backgroundColor={bg}>{pad(sellText, 11)}</Text>
      <Text color={profitCellColor} backgroundColor={bg} bold>{pad(profitText, 11)}</Text>
      <Text color={isPack(a.id) ? 'gray' : exchangeableCache.get(a.id) === true ? 'green' : exchangeableCache.get(a.id) === false ? 'red' : 'gray'} backgroundColor={bg}>{pad(isPack(a.id) ? '—' : exchangeableCache.get(a.id) === true ? '✓' : exchangeableCache.get(a.id) === false ? '✗' : '?', 5)}</Text>
      <Text color="gray" backgroundColor={bg}>{pad(categoryCache.get(a.id) || '', catWidth)}</Text>
      <Text>   </Text>
      {isLocked(a.title) && <Text color="yellow" backgroundColor={bg} bold>[LOCKED] </Text>}
      {duplicateAuctionIds.has(a.id) && <Text color="gray" backgroundColor={bg} bold dimColor>[DUP] </Text>}
      {(() => {
        // Title column is 60 chars total. Subtract whatever the badges
        // consumed so the URL column stays aligned.
        const lockedW = isLocked(a.title) ? '[LOCKED] '.length : 0;
        const dupW    = duplicateAuctionIds.has(a.id) ? '[DUP] '.length : 0;
        const titleW  = 60 - lockedW - dupW;
        return <Text backgroundColor={bg}>{pad(a.title || '(loading...)', titleW)}</Text>;
      })()}
      <Text>   </Text>
      <Text color="blue">https://www.dealdash.com/auction/{a.id}</Text>
    </Box>
  );
}

function TableHeader({ showSpent, catWidth = 14 }: { showSpent?: boolean; catWidth?: number }) {
  return (
    <Box>
      <Box width={4}><Text bold> </Text></Box>
      <Box width={4}><Text bold>Bid</Text></Box>
      <Box width={9}><Text bold>Price</Text></Box>
      <Box width={8}><Text bold>Booked</Text></Box>
      {showSpent && <Box width={7}><Text bold>Spent</Text></Box>}
      <Box width={8}><Text bold>TotBids</Text></Box>
      <Box width={9}><Text bold>$Spent</Text></Box>
      <Box width={11}><Text bold>$Sell</Text></Box>
      <Box width={11}><Text bold>Profit</Text></Box>
      <Box width={5}><Text bold>Exch</Text></Box>
      <Box width={catWidth}><Text bold>Category</Text></Box>
      <Box width={3} />
      <Box width={60}><Text bold>Title</Text></Box>
      <Box width={3} />
      <Text bold>Link</Text>
    </Box>
  );
}

function RateCell({ v }: { v: number | null }) {
  if (v == null) return <Text color="gray">—</Text>;
  const sign = v >= 0 ? '+' : '-';
  const color = v >= 0 ? 'green' : 'red';
  return <Text bold color={color}>{sign}${Math.abs(v).toFixed(2)}</Text>;
}

function isArtCategory(id: number): boolean {
  const cat = categoryCache.get(id) || '';
  return /\bart(work)?\b|wall\s*art/i.test(cat);
}

interface RatesShape { m1: number | null; m5: number | null; m15: number | null; m30: number | null; h1: number | null; d1: number | null; w1: number | null; mo1: number | null; y1: number | null }
function MyAuctionsView({ items, allItems, costPerBid, storeBidPrice, selectedId, dailyNet, velocity, rates, tightness, alerts, presorted }: { items: DisplayAuction[]; allItems?: DisplayAuction[]; costPerBid: number; storeBidPrice: number; selectedId?: number | null; dailyNet?: number; velocity?: { spentPerMin: number; earnedPerMin: number }; rates?: RatesShape; tightness?: number; alerts?: Alert[]; presorted?: boolean }) {
  // Skip art unless it's exchangeable (then we can flip it for bids)
  const filtered = items.filter(a => !isArtCategory(a.id) || exchangeableCache.get(a.id) === true);
  // If the upstream already sorted these (e.g. Waiting tab uses rejoin score)
  // don't clobber it by re-sorting here.
  const sorted = presorted ? filtered : [...filtered].sort((a, b) => a.bidders - b.bidders);
  if (!sorted.length) return <Text color="gray">No auctions to show.</Text>;

  // Aggregate totals across the FULL list (all pages), not just the current page
  const totalsSource = (allItems || items).filter(a => !isArtCategory(a.id));
  let totSpent = 0, totSell = 0, totProfit = 0, priced = 0, unpriced = 0;
  for (const a of totalsSource) {
    const spent = a.bidsSpent * costPerBid + Number(a.ddPrice || 0);
    totSpent += spent;
    const v = getResaleValue(a, storeBidPrice);
    if (v) {
      totSell += v.value;
      totProfit += v.value - spent;
      priced++;
    } else {
      unpriced++;
    }
  }
  const profitColor = totProfit >= 0 ? 'green' : 'red';
  const profitStr = `${totProfit >= 0 ? '+' : '-'}$${Math.abs(totProfit).toFixed(2)}`;

  // Auto-fit Category column to its widest value
  const catWidth = Math.max(8, ...sorted.map(a => (categoryCache.get(a.id) || '').length)) + 2;

  return (
    <Box flexDirection="column">
      <TableHeader showSpent catWidth={catWidth} />
      {sorted.map(a => <AuctionRow key={a.id} a={a} showSpent costPerBid={costPerBid} storeBidPrice={storeBidPrice} selected={a.id === selectedId} catWidth={catWidth} />)}
      <Box marginTop={1} flexDirection="column">
        <Text bold color="yellow">
          TOTAL ({totalsSource.length} auctions{unpriced > 0 ? `, ${unpriced} unpriced` : ''}):
          spent <Text color="magenta">${totSpent.toFixed(2)}</Text>  |
          resale <Text color="cyan">${totSell.toFixed(2)}</Text>  |
          projected profit <Text color={profitColor}>{profitStr}</Text>
        </Text>
        {dailyNet !== undefined && (
          <Text>
            📅 Today: <Text bold color={dailyNet >= 0 ? 'green' : 'red'}>{dailyNet >= 0 ? '+' : '-'}${Math.abs(dailyNet).toFixed(2)}</Text>
            {velocity && <Text color="gray">   ⚡ velocity: <Text color="red">{velocity.spentPerMin.toFixed(1)}</Text> bids/min spent vs <Text color="green">{velocity.earnedPerMin.toFixed(1)}</Text> bids/min earned</Text>}
          </Text>
        )}
        {rates && (
          <Box flexDirection="column">
            <Text color="gray">
              📈 1m <RateCell v={rates.m1} /> · 5m <RateCell v={rates.m5} /> · 15m <RateCell v={rates.m15} /> · 30m <RateCell v={rates.m30} /> · 1h <RateCell v={rates.h1} />
            </Text>
            <Text color="gray">
              📈 1d <RateCell v={rates.d1} /> · 1w <RateCell v={rates.w1} /> · 1mo <RateCell v={rates.mo1} /> · 1y <RateCell v={rates.y1} />
              {tightness !== undefined && <Text color={tightness > 1 ? 'yellow' : tightness < 1 ? 'green' : 'gray'}>   ⚙ tightness ×{tightness.toFixed(2)}</Text>}
            </Text>
          </Box>
        )}
        {alerts && alerts.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="white">📣 Recent alerts:</Text>
            {alerts.slice().reverse().map((a, i) => {
              const color = a.level === 'good' ? 'green' : a.level === 'bad' ? 'red' : 'yellow';
              const ts = new Date(a.at).toLocaleTimeString();
              return <Text key={i} color={color}>  [{ts}] {a.text}</Text>;
            })}
          </Box>
        )}
      </Box>
    </Box>
  );
}

function WonView({ wins, costPerBid, storeBidPrice }: { wins: State['wins']; costPerBid: number; storeBidPrice: number }) {
  // Trigger market lookups for all non-pack, non-exchanged wins
  useEffect(() => {
    for (const w of wins) {
      if (w.exchanged) continue;
      if (!/Bid Pack|Bids! \+|bidpack/i.test(w.title)) fetchMarketPrice(w.title);
    }
  }, [wins.length]);

  if (!wins.length) return <Text color="gray">No wins yet.</Text>;
  let totalCost = 0;
  let totalSell = 0;
  return (
    <Box flexDirection="column">
      {wins.map(w => {
        const placed = bidsSpent.get(w.id) || 0;
        const bidCost = placed * costPerBid;

        // Exchanged-for-bids: we never paid the win price; we bought bids.
        // Effective cost per bid acquired = bidCost / exchangedBids.
        // Effective profit = (bids received × store rate) - bidCost.
        if (w.exchanged) {
          const effPerBid = w.exchangedBids > 0 ? bidCost / w.exchangedBids : 0;
          const bidValue = w.exchangedBids * storeBidPrice;
          const profit = bidValue - bidCost;
          totalCost += bidCost;
          totalSell += bidValue;
          return (
            <Box key={w.id} flexDirection="column" marginBottom={1}>
              <Text color="green">✓ <Text bold color="white">{w.title}</Text>{categoryCache.get(w.id) ? <Text color="gray">  [{categoryCache.get(w.id)}]</Text> : null}{exchangeableCache.get(w.id) !== undefined ? <Text color={exchangeableCache.get(w.id) ? 'green' : 'red'}>  Exch:{exchangeableCache.get(w.id) ? '✓' : '✗'}</Text> : null}<Text color="yellow" bold>  ⇄ Exchanged for {w.exchangedBids} bids</Text></Text>
              <Text color="gray">   bids: {placed} × ${costPerBid.toFixed(3)} = ${bidCost.toFixed(2)}  |  received: <Text color="cyan">{w.exchangedBids} bids</Text> @ <Text bold color="cyan">${effPerBid.toFixed(4)}/bid</Text> (store ${storeBidPrice.toFixed(3)})  |  profit: <Text bold color={profit >= 0 ? 'green' : 'red'}>{profit >= 0 ? '+' : '-'}${Math.abs(profit).toFixed(2)}</Text></Text>
              <Text color="blue">   https://www.dealdash.com/auction/{w.id}</Text>
            </Box>
          );
        }

        const cost = bidCost + w.price;
        totalCost += cost;

        const isPackTitle = /Bid Pack|Bids! \+|bidpack/i.test(w.title);
        let market: { min: number; median: number; mean?: number; count: number } | undefined;
        if (!isPackTitle) {
          market = marketCache[w.title] || marketCache[cleanTitle(w.title)];
        }
        const sell = market && market.count > 0 ? (market.mean ?? market.median ?? market.min) : 0;
        if (sell) totalSell += sell;
        const profit = sell - cost;
        const profitText = isPackTitle
          ? <Text color="gray">(bid pack)</Text>
          : !market
            ? <Text color="gray">calc...</Text>
            : market.count === 0
              ? <Text color="red">no match</Text>
              : <Text bold color={profit >= 0 ? 'green' : 'red'}>{profit >= 0 ? '+' : '-'}${Math.abs(profit).toFixed(2)}</Text>;
        const sellText = isPackTitle
          ? '—'
          : !market || market.count === 0
            ? '?'
            : `$${sell.toFixed(0)}`;

        return (
          <Box key={w.id} flexDirection="column" marginBottom={1}>
            <Text color="green">✓ <Text bold color="white">{w.title}</Text>{categoryCache.get(w.id) ? <Text color="gray">  [{categoryCache.get(w.id)}]</Text> : null}{exchangeableCache.get(w.id) !== undefined ? <Text color={exchangeableCache.get(w.id) ? 'green' : 'red'}>  Exch:{exchangeableCache.get(w.id) ? '✓' : '✗'}</Text> : null}</Text>
            <Text color="gray">   bids: {placed} × ${costPerBid.toFixed(3)} = ${bidCost.toFixed(2)}  |  win: ${w.price.toFixed(4)}  |  cost: <Text bold color="yellow">${cost.toFixed(2)}</Text>  |  sell: <Text color="cyan">{sellText}</Text>  |  profit: {profitText}</Text>
            <Text color="blue">   https://www.dealdash.com/auction/{w.id}</Text>
          </Box>
        );
      })}
      <Text bold color="yellow">💰 Grand total cost: ${totalCost.toFixed(2)}  |  value (resale + bid exchanges): ${totalSell.toFixed(2)}  |  net: <Text color={(totalSell - totalCost) >= 0 ? 'green' : 'red'}>{(totalSell - totalCost) >= 0 ? '+' : '-'}${Math.abs(totalSell - totalCost).toFixed(2)}</Text></Text>
    </Box>
  );
}

function LookupView({ costPerBid, storeBidPrice, focused, setFocused }: { costPerBid: number; storeBidPrice: number; focused: boolean; setFocused: (b: boolean) => void }) {
  const [value, setValue] = useState('');
  const [result, setResult] = useState<string>('Press i to enter input mode, paste URL, Enter to lookup, esc to blur.');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (raw: string) => {
    const m = raw.match(/(\d{6,})/);
    if (!m) { setResult('Could not parse an auction ID from that input.'); return; }
    const id = Number(m[1]);
    setBusy(true);
    setResult(`Looking up ${id}...`);
    try {
      // Fetch auction details + static metadata
      const [{ details, info }, sd] = await Promise.all([
        getAuctionData([id]),
        fetch(`https://www.dealdash.com/api/v1/auction/staticData?auctionIds%5B%5D=${id}&withBidderDetails=1`, {
          headers: { Cookie: process.env.DEALDASH_COOKIE || '' },
        }).then(r => r.json()).catch(() => null) as Promise<{ static?: Record<string, { name?: string; categoryName?: string; bidsPlacedByWinner?: string; buyItNowPrice?: number }> } | null>,
      ]);

      const det = details[0];
      const inf = info.get(id);
      const meta = sd?.static?.[String(id)];
      const title = meta?.name || `auction ${id}`;
      const category = meta?.categoryName || 'Unknown';
      const binPrice = meta?.buyItNowPrice || 0;
      const winnerSoFar = meta?.bidsPlacedByWinner;

      const myBidsPlaced = bidsSpent.get(id) || 0;
      const currentPrice = inf ? Number(inf.r) : 0;
      const currentBooked = inf?.bb?.c ?? 0;
      const totalBids = inf?.x ?? 0;
      const bidders = det ? new Set(det.history.map(h => h[2])).size : 0;

      // Cache category for isPack() check
      if (meta?.categoryName) {
        const { categoryCache: cc } = await import('../dealdash/api.js');
        cc.set(id, meta.categoryName);
      }

      const isPackAuction = category === 'Packs';
      const packSize = isPackAuction ? packSizeFromTitle(title) : 0;

      const out: string[] = [];
      out.push(`📦 ${title}`);
      out.push(`   Category: ${category}  |  BIN price: $${binPrice}`);
      out.push(`   Current price: $${currentPrice.toFixed(2)}  |  Total bids placed: ${totalBids}  |  Bidders: ${bidders}`);
      if (winnerSoFar) out.push(`   Current leader has placed: ${winnerSoFar} bids`);
      out.push('');
      out.push(`   Your bids placed: ${myBidsPlaced}  |  Currently booked: ${currentBooked}`);
      const spent = myBidsPlaced * costPerBid + currentPrice;
      out.push(`   Your cost so far: $${spent.toFixed(2)}`);
      out.push('');

      let resaleValue = 0;
      let valueSource = '';
      if (isPackAuction && packSize > 0) {
        resaleValue = packSize * storeBidPrice;
        valueSource = `${packSize} bids × $${storeBidPrice}/bid (store rate)`;
      } else if (isPackAuction) {
        out.push('   📊 Pack size could not be parsed from title');
      } else {
        // Non-pack: use ValueSERP
        if (!marketCache[title]) await fetchMarketPrice(title);
        const market = marketCache[title];
        if (!market) {
          out.push('   📊 Market price: lookup failed');
        } else if (market.count === 0) {
          out.push('   📊 Market price: NO MATCHES — unpriceable');
          out.push('   ❌ SKIP');
        } else {
          resaleValue = market.mean ?? market.median ?? market.min;
          valueSource = `ValueSERP trimmed mean of ${market.count} listings (min $${market.min}, median $${market.median})`;
        }
      }

      if (resaleValue > 0) {
        const profit = resaleValue - spent;
        out.push(`   📊 Resale value: $${resaleValue.toFixed(2)}  (${valueSource})`);
        out.push(`   💰 Projected profit: ${profit >= 0 ? '+' : '-'}$${Math.abs(profit).toFixed(2)}`);
        out.push(`   ${profit >= MIN_PROFIT ? '✅ PROFITABLE' : '❌ SKIP — below $' + MIN_PROFIT + ' min margin'}`);
      }
      setResult(out.join('\n'));
    } catch (e) {
      setResult(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setValue(''); // clear input for the next paste
      setFocused(false); // blur so mouse moves don't leak garbage
    }
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text>URL or ID: </Text>
        {focused ? (
          <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} placeholder="https://www.dealdash.com/auction/16340759" />
        ) : (
          <Text color="gray">[press i to type, esc to blur]</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {result.split('\n').map((line, i) => (
          <Text key={i} color={
            line.includes('✅') ? 'green' :
            line.includes('❌') ? 'red' :
            line.includes('NO MATCHES') ? 'red' :
            line.includes('📦') ? 'cyan' :
            line.includes('📊') || line.includes('💰') ? 'yellow' :
            'white'
          }>{line}</Text>
        ))}
      </Box>
      {busy && <Text color="gray">Looking up...</Text>}
    </Box>
  );
}

function CryptoArbView() {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Cross-Exchange Arbitrage (Gemini / Kraken / Binance.US)</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Box width={10}><Text bold>Pair</Text></Box>
          <Box width={12}><Text bold>Buy @</Text></Box>
          <Box width={12}><Text bold>Sell @</Text></Box>
          <Box width={12}><Text bold>Spread</Text></Box>
          <Box width={12}><Text bold>Net $/u</Text></Box>
          <Box width={15}><Text bold>Buy Exch</Text></Box>
          <Box width={15}><Text bold>Sell Exch</Text></Box>
          <Text bold>Status</Text>
        </Box>
        <Text color="gray">No live data yet — feeds are stubbed. Implement @b1dz/source-crypto-arb feeds to activate.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Pairs: BTC-USD, ETH-USD, SOL-USD  ·  Poll: 1s  ·  Taker fees: Gemini 0.40%, Kraken 0.26%, Binance.US 0.10%</Text>
      </Box>
    </Box>
  );
}

function CryptoTradeView() {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Day Trading (single-exchange strategies)</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Box width={10}><Text bold>Pair</Text></Box>
          <Box width={10}><Text bold>Side</Text></Box>
          <Box width={12}><Text bold>Price</Text></Box>
          <Box width={12}><Text bold>Strength</Text></Box>
          <Box width={20}><Text bold>Strategy</Text></Box>
          <Text bold>Reason</Text>
        </Box>
        <Text color="gray">No signals yet — momentum strategy is stubbed. Implement feed clients to activate.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Strategy: momentum (3 rising ticks)  ·  Exchange: Gemini  ·  Poll: 5s</Text>
      </Box>
    </Box>
  );
}

function LogsView() {
  const recent = logBuffer.slice(-30);
  if (!recent.length) return <Text color="gray">No log entries yet.</Text>;
  return (
    <Box flexDirection="column">
      {recent.map((line, i) => (
        <Text key={i} color={
          line.includes('failed') || line.includes('error') ? 'red' :
          line.includes('booked') ? 'green' :
          line.includes('cancelled') ? 'yellow' : 'gray'
        }>{line}</Text>
      ))}
    </Box>
  );
}

function LostView({ lost, allLost, costPerBid }: { lost: State['lost']; allLost?: State['lost']; costPerBid: number }) {
  if (!lost.length) return <Text color="gray">No lost auctions.</Text>;
  // Total cost across the FULL lost list, not just the current page, so the
  // grand total reflects everything we burned.
  const totalsSource = allLost ?? lost;
  let grandTotal = 0;
  for (const l of totalsSource) grandTotal += (bidsSpent.get(l.id) || 0) * costPerBid;
  return (
    <Box flexDirection="column">
      {lost.map(l => {
        const ex = exchangeableCache.get(l.id);
        const reason = exitReason.get(l.id);
        const placed = bidsSpent.get(l.id) || 0;
        const cost = placed * costPerBid;
        return (
          <Text key={l.id} color="red">
            ✗ {l.title}
            {categoryCache.get(l.id) ? <Text color="gray">  [{categoryCache.get(l.id)}]</Text> : null}
            {ex !== undefined ? <Text color={ex ? 'green' : 'red'}>  Exch:{ex ? '✓' : '✗'}</Text> : null}
            <Text color="magenta">  spent {placed} bids = ${cost.toFixed(2)}</Text>
            {reason ? <Text color="yellow">  ({reason})</Text> : null}
            {'  '}<Text color="blue">https://www.dealdash.com/auction/{l.id}</Text>
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text bold color="yellow">
          TOTAL LOSSES ({totalsSource.length} auctions):  burned <Text color="red">${grandTotal.toFixed(2)}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [state, setState] = useState<State>(empty);
  const [tab, setTab] = useState<Tab>('My');
  const [lookupFocused, setLookupFocused] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;
  // DIAGNOSTIC: catch any press anywhere to verify mouse events arrive
  const appRef = useRef(null);
  useOnPress(appRef, (e) => {
    console.log(`MOUSE PRESS x=${(e as { x?: number }).x} y=${(e as { y?: number }).y}`);
  });

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const next = await tick();
        if (alive) setState(next);
      } catch (e) {
        console.log(`tick error: ${(e as Error).message}\n${(e as Error).stack}`);
      }
    };
    run();
    const i = setInterval(run, POLL_MS);
    return () => { alive = false; clearInterval(i); };
  }, []);

  const profit = state.myDisplay.filter(d => profitability(d, state.costPerBid, state.storeBidPrice) === 'profit');
  const loss = state.myDisplay.filter(d => profitability(d, state.costPerBid, state.storeBidPrice) === 'loss');
  // 1v1: any auction (mine or joinable) where there's exactly one opponent — these are
  // the active fights or snipes worth watching.
  const oneVone = [...state.myDisplay, ...state.joinable]
    .filter((a, i, arr) => arr.findIndex(b => b.id === a.id) === i)
    .filter(d => d.bidders === 2);

  // Items currently shown in the active auction-list tab, sorted to match MyAuctionsView
  const listsByTab: Partial<Record<Tab, DisplayAuction[]>> = {
    My: state.myDisplay, '1v1': oneVone, Profit: profit, Loss: loss, Waiting: state.waiting, Joinable: state.joinable,
  };
  // Waiting tab is already sorted by rejoin score in the tick — preserve
  // that order. Everything else gets a default by-bidders sort.
  const _src = listsByTab[tab] ? [...listsByTab[tab]!].filter(a => !isArtCategory(a.id) || exchangeableCache.get(a.id) === true) : [];
  const fullList = tab === 'Waiting' ? _src : _src.sort((a, b) => a.bidders - b.bidders);
  const presorted = tab === 'Waiting';
  const WON_LOST_PAGE_SIZE_PRE = 10;
  const wonPagesPre = Math.max(1, Math.ceil(state.wins.length / WON_LOST_PAGE_SIZE_PRE));
  const lostPagesPre = Math.max(1, Math.ceil(state.lost.length / WON_LOST_PAGE_SIZE_PRE));
  const tabPageCount =
    tab === 'Won' ? wonPagesPre :
    tab === 'Lost' ? lostPagesPre :
    Math.max(1, Math.ceil(fullList.length / PAGE_SIZE));
  const totalPages = tabPageCount;
  const safePage = Math.min(page, totalPages - 1);
  const currentList = fullList.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const safeCursor = currentList.length ? Math.min(cursor, currentList.length - 1) : 0;
  const selectedId = currentList[safeCursor]?.id ?? null;
  // Pagination also applies to non-auction tabs (Won, Lost) — slice the full lists for those views
  // Won/Lost rows are taller / not real tables — keep those pages tighter
  const WON_LOST_PAGE_SIZE = 10;
  const pageOfWins = state.wins.slice(safePage * WON_LOST_PAGE_SIZE, (safePage + 1) * WON_LOST_PAGE_SIZE);
  const pageOfLost = state.lost.slice(safePage * WON_LOST_PAGE_SIZE, (safePage + 1) * WON_LOST_PAGE_SIZE);
  const wonPages = Math.max(1, Math.ceil(state.wins.length / WON_LOST_PAGE_SIZE));
  const lostPages = Math.max(1, Math.ceil(state.lost.length / WON_LOST_PAGE_SIZE));

  useInput((input, key) => {
    // When the lookup input is focused, only handle escape (to blur) — let TextInput handle the rest
    if (lookupFocused) {
      if (key.escape) setLookupFocused(false);
      return;
    }
    if (key.ctrl && input === 'c') { exit(); return; }
    if (input === 'q') {
      // Final flush of pending state, then hard exit so the background
      // setInterval timer can't keep the event loop alive.
      void (async () => {
        try {
          const sync = await import('../dealdash/state-sync.js');
          sync.stopBackgroundFlush();
          const userId = process.env.B1DZ_USER_ID;
          if (userId) await sync.flushAll(userId, 'dealdash');
        } catch {}
        exit();
        // Belt + suspenders — give Ink ~50ms to unmount, then force-exit.
        setTimeout(() => process.exit(0), 50);
      })();
      return;
    }
    if (input === 'e') {
      exchangeableOnly = !exchangeableOnly;
      console.log(`exchangeable-only mode: ${exchangeableOnly ? 'ON' : 'OFF'}`);
      return;
    }
    if (input === 's') {
      snipeMode = !snipeMode;
      console.log(`snipe mode: ${snipeMode ? 'ON' : 'OFF'}`);
      return;
    }
    if (input === 'l') {
      lifeSavingMode = !lifeSavingMode;
      console.log(`life-saving mode: ${lifeSavingMode ? 'ON' : 'OFF'}`);
      return;
    }
    if (tab === 'Lookup' && input === 'i') { setLookupFocused(true); return; }
    const idx = TABS.indexOf(tab);
    if (key.leftArrow) { setTab(TABS[(idx - 1 + TABS.length) % TABS.length]); setCursor(0); setPage(0); return; }
    if (key.rightArrow) { setTab(TABS[(idx + 1) % TABS.length]); setCursor(0); setPage(0); return; }
    if (input >= '1' && input <= '9') { setTab(TABS[Number(input) - 1]); setCursor(0); setPage(0); return; }
    if (key.pageDown || input === ']') { setPage(p => p + 1); setCursor(0); return; }
    if (key.pageUp || input === '[') { setPage(p => Math.max(0, p - 1)); setCursor(0); return; }
    // Row navigation + cancel for auction-list tabs
    if (currentList.length) {
      if (key.upArrow || input === 'k') { setCursor(c => Math.max(0, c - 1)); return; }
      if (key.downArrow || input === 'j') { setCursor(c => Math.min(currentList.length - 1, c + 1)); return; }
      if (input === 'x' && selectedId != null) {
        const target = selectedId;
        const item = currentList[safeCursor];
        cancelBidBuddy(target).then(() => {
          console.log(`manual cancel ${target}: ${item?.title || ''}`);
        }).catch(e => console.log(`cancel error ${target}: ${(e as Error).message}`));
        return;
      }
    }
  }, { isActive: !!isRawModeSupported });

  const counts: Record<Tab, number> = {
    My: state.myDisplay.length,
    '1v1': oneVone.length,
    Profit: profit.length,
    Loss: loss.length,
    Waiting: state.waiting.length,
    Joinable: state.joinable.length,
    Won: state.wins.length,
    Lost: state.lost.length,
    Arb: 0,
    Trade: 0,
    Lookup: 0,
    Logs: logBuffer.length,
  };

  return (
    <Box flexDirection="column" ref={appRef}>
      <Header s={state} />
      <TabBar active={tab} onSelect={setTab} counts={counts} />
      {tab === 'My' && <MyAuctionsView items={currentList} allItems={fullList} costPerBid={state.costPerBid} storeBidPrice={state.storeBidPrice} selectedId={selectedId} dailyNet={state.dailyNet} velocity={state.velocity} rates={state.rates} tightness={state.tightness} alerts={state.alerts} />}
      {tab === '1v1' && <MyAuctionsView items={currentList} allItems={fullList} costPerBid={state.costPerBid} storeBidPrice={state.storeBidPrice} selectedId={selectedId} dailyNet={state.dailyNet} velocity={state.velocity} rates={state.rates} tightness={state.tightness} alerts={state.alerts} />}
      {tab === 'Profit' && <MyAuctionsView items={currentList} allItems={fullList} costPerBid={state.costPerBid} storeBidPrice={state.storeBidPrice} selectedId={selectedId} dailyNet={state.dailyNet} velocity={state.velocity} rates={state.rates} tightness={state.tightness} alerts={state.alerts} />}
      {tab === 'Loss' && <MyAuctionsView items={currentList} allItems={fullList} costPerBid={state.costPerBid} storeBidPrice={state.storeBidPrice} selectedId={selectedId} dailyNet={state.dailyNet} velocity={state.velocity} rates={state.rates} tightness={state.tightness} alerts={state.alerts} />}
      {tab === 'Waiting' && <MyAuctionsView items={currentList} allItems={fullList} costPerBid={state.costPerBid} storeBidPrice={state.storeBidPrice} selectedId={selectedId} dailyNet={state.dailyNet} velocity={state.velocity} rates={state.rates} tightness={state.tightness} alerts={state.alerts} presorted />}
      {tab === 'Joinable' && <MyAuctionsView items={currentList} allItems={fullList} costPerBid={state.costPerBid} storeBidPrice={state.storeBidPrice} selectedId={selectedId} dailyNet={state.dailyNet} velocity={state.velocity} rates={state.rates} tightness={state.tightness} alerts={state.alerts} />}
      {tab === 'Won' && <WonView wins={pageOfWins} costPerBid={state.costPerBid} storeBidPrice={state.storeBidPrice} />}
      {tab === 'Lost' && <LostView lost={pageOfLost} allLost={state.lost} costPerBid={state.costPerBid} />}
      <Box marginTop={1}><Text color="gray">page {safePage + 1}/{tab === 'Won' ? wonPages : tab === 'Lost' ? lostPages : totalPages}  ([ ] or PgUp/PgDn)</Text></Box>
      {tab === 'Arb' && <CryptoArbView />}
      {tab === 'Trade' && <CryptoTradeView />}
      {tab === 'Lookup' && <LookupView costPerBid={state.costPerBid} storeBidPrice={state.storeBidPrice} focused={lookupFocused} setFocused={setLookupFocused} />}
      {tab === 'Logs' && <LogsView />}
      <Box marginTop={1}><Text color="gray">q quit  |  ←/→ or 1-9 tabs  |  ↑/↓ (j/k) row  |  [ ] or PgUp/PgDn page  |  x cancel BidBuddy  |  e ExchangeOnly  |  s Snipe  |  l LifeSaving</Text></Box>
    </Box>
  );
}

// Initialize the typed bridge (builds fetcher + storage from env creds)
try { initBridge(); } catch (e) { console.error(`bridge init failed: ${(e as Error).message}`); }

// Hydrate every persisted cache from Supabase BEFORE the first tick fires,
// then start the background flush. By this point both api.ts and this file
// have run all their registerCache() calls, so the registry is complete.
{
  const { hydrateAll, startBackgroundFlush } = await import('../dealdash/state-sync.js');
  const userId = process.env.B1DZ_USER_ID;
  if (userId) {
    try { await hydrateAll(userId, 'dealdash'); } catch (e) { console.error(`hydrate failed: ${(e as Error).message}`); }
    startBackgroundFlush(userId, 'dealdash', 30_000);
  }
}

render(
  <MouseProvider>
    <App />
  </MouseProvider>,
  { patchConsole: false }
);
