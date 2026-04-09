/**
 * DealDash worker — wires the typed polling + strategy modules from
 * @b1dz/source-dealdash into the daemon's per-user scheduler.
 *
 * Per tick:
 *   1. Load cookies from source_state.payload.credentials
 *   2. Hydrate mode state from source_state.payload.daemon.mode
 *   3. Build a DealDashFetcher scoped to that user
 *   4. Call pollOnce(ctx) to fetch + normalize + persist caches
 *   5. Project details + info → DealDashAuction[] via the shared
 *      toDisplayAuctions helper (proper bidders-from-history)
 *   6. decide() — pure strategy → Decision[] + next mode
 *   7. Execute decisions, persist next mode + heartbeat
 *
 * Mode state is persisted in source_state.payload.daemon.mode so a daemon
 * restart doesn't reset focus id / hysteresis / user toggles.
 */

import type { SourceWorker, UserContext } from '../types.js';
import {
  pollOnce,
  toDisplayAuctions,
  makeDealDashFetcher,
  bookBid,
  cancelBidBuddy,
  exchangeWinForBids,
  decide,
  makeBalanceMode,
  DEFAULT_STRATEGY,
  type MarketEntry,
  type ModeState,
  type DealDashCreds,
} from '@b1dz/source-dealdash';
import { runnerStorageFor } from '../runner-storage.js';

// ---------- mode state (persistence) ----------

interface StoredModeState {
  balance: { inLow: boolean; enterAt: number; exitAt: number };
  focusKeepId: number | null;
  lifeSavingMode: boolean;
  exchangeableOnly: boolean;
  stopLoss: boolean;
  lockedProductIds: number[];
}

function hydrateMode(stored: StoredModeState | undefined): ModeState {
  return {
    balance: stored?.balance
      ? { inLow: stored.balance.inLow, enterAt: stored.balance.enterAt, exitAt: stored.balance.exitAt }
      : makeBalanceMode(),
    focusKeepId: stored?.focusKeepId ?? null,
    lifeSavingMode: stored?.lifeSavingMode ?? (process.env.LIFE_SAVING_MODE === '1'),
    exchangeableOnly: stored?.exchangeableOnly ?? (process.env.EXCHANGEABLE_ONLY === '1'),
    stopLoss: stored?.stopLoss ?? false,
    lockedProductIds: new Set(stored?.lockedProductIds ?? []),
  };
}

function serializeMode(m: ModeState): StoredModeState {
  return {
    balance: m.balance,
    focusKeepId: m.focusKeepId,
    lifeSavingMode: m.lifeSavingMode,
    exchangeableOnly: m.exchangeableOnly,
    stopLoss: m.stopLoss,
    lockedProductIds: [...m.lockedProductIds],
  };
}

// ---------- worker ----------

export const dealdashWorker: SourceWorker = {
  id: 'dealdash',
  pollIntervalMs: 5000,
  hasCredentials(payload) {
    const c = payload?.credentials as DealDashCreds | undefined;
    return !!(c?.phpsessid && c?.rememberme);
  },
  async tick(ctx: UserContext) {
    const creds = ctx.payload?.credentials as DealDashCreds | undefined;
    if (!creds) return;
    const fetcher = makeDealDashFetcher(creds);
    const storage = runnerStorageFor(ctx);

    // 1. Polling — writes updated caches back to source_state
    const r = await pollOnce({ userId: ctx.userId, fetcher, storage });

    // 2. Hydrate mode from whatever's currently in source_state. pollOnce
    // merged its caches in; we read the refreshed payload.
    const daemonState = (ctx.payload?.daemon as { mode?: StoredModeState } | undefined)?.mode;
    const mode = hydrateMode(daemonState);

    // 3. Project raw API → typed DealDashAuction[] with proper bidder counts
    const username = process.env.DEALDASH_USERNAME ?? '';
    const auctions = toDisplayAuctions({
      details: r.details,
      info: r.info,
      titles: r.caches.titles,
      bidsSpent: r.caches.bidsSpent,
      username,
    });

    // 4. Run strategy (pure function)
    const decision = decide({
      bidBalance: r.bidBalance,
      auctions,
      categoryOf: id => r.caches.categories[id],
      marketOf: (a): MarketEntry | null => r.caches.marketPrices[a.title] ?? null,
      productIdOf: id => r.caches.productIds[id],
      exchangeableOf: id => r.caches.exchangeable[id],
      exchangeRateOf: pid => r.caches.exchangeRates[pid],
      cfg: DEFAULT_STRATEGY,
      mode,
    });

    // 5. Execute decisions independently so one failure doesn't block the rest
    for (const d of decision.decisions) {
      try {
        if (d.kind === 'book') {
          await bookBid(fetcher, d.auctionId, d.count);
        } else if (d.kind === 'cancel') {
          await cancelBidBuddy(fetcher, d.auctionId);
        } else if (d.kind === 'exchange') {
          await exchangeWinForBids(fetcher, d.auctionId, d.orderId);
        } else if (d.kind === 'alert') {
          const current = (ctx.payload?.alerts as Array<{ at: string; level: string; text: string }>) ?? [];
          current.push({ at: new Date().toISOString(), level: d.level, text: d.text });
          while (current.length > 50) current.shift();
          await ctx.savePayload({ alerts: current });
        }
      } catch (e) {
        console.error(`b1dzd: decision ${d.kind} failed: ${(e as Error).message}`);
      }
    }

    // 6. Persist next mode state + heartbeat
    await ctx.savePayload({
      daemon: {
        lastTickAt: new Date().toISOString(),
        worker: 'dealdash',
        status: 'running',
        bidBalance: r.bidBalance,
        focusKeepId: decision.focusKeepId,
        decisionsThisTick: decision.decisions.length,
        mode: serializeMode(decision.nextMode),
      },
    });
  },
};
