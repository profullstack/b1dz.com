/**
 * decide() — pure strategy function.
 *
 * Given a snapshot of the world (poll result + caches + current mode
 * state + config), emit a list of typed Decisions the daemon executes.
 * No I/O. No timers. No globals. Deterministic. Testable.
 *
 * Decisions are discriminated unions so the daemon can handle each kind
 * in a switch without guessing shapes:
 *
 *   { kind: 'book',    auctionId, count, reason }
 *   { kind: 'cancel',  auctionId,        reason }
 *   { kind: 'exchange', auctionId, orderId, reason }
 *   { kind: 'alert',   level, text,         linkId? }
 *
 * The gates are ported from the lifted TUI tick() in priority order:
 *   1. Force-exit committed non-pack fights below the rebook floor
 *   2. Pack overpriced — abandon packs above MAX_PACK_PER_BID
 *   3. Low-balance dedup by productId (keep highest sunk cost)
 *   4. Focus pick via rejoinScore (winner per tick stashed in next state)
 *   5. Auto-cancel too-many-bidder fights
 *   6. Rebook committed auctions whose queue is shallow
 *   7. New entries on fresh 2-bidder packs (when acquire/life-saving)
 */

import type {
  DealDashAuction,
  MarketEntry,
  StrategyConfig,
} from '../types.js';
import {
  isPack,
  packSizeFromTitle,
  packCostPerBid,
  totalSpent,
  projectedProfit,
  profitability,
} from './profit.js';
import { rejoinScore } from './score.js';
import { applyBalance, type BalanceMode } from './balance.js';

// ---------- input / output shapes ----------

export interface ModeState {
  balance: BalanceMode;
  /** Focus target from the previous tick (null when not focusing) */
  focusKeepId: number | null;
  /** Manual override — stays in survival until user turns it off */
  lifeSavingMode: boolean;
  /** Manual override — packs + exchangeables only */
  exchangeableOnly: boolean;
  /** Stop-loss tripped? */
  stopLoss: boolean;
  /** Cross-session rebid lockout: productIds we've won in the last 30d */
  lockedProductIds: Set<number>;
}

export interface DecisionContext {
  bidBalance: number;
  /** Display list — one per auction from our feed (my + joinable merged) */
  auctions: DealDashAuction[];
  /** Auction id → category (e.g. "Packs", "Watches") */
  categoryOf: (id: number) => string | undefined;
  /** Auction id → market pricing entry */
  marketOf: (auction: DealDashAuction) => MarketEntry | null | undefined;
  /** Auction id → productId from the scraped page info */
  productIdOf: (id: number) => number | undefined;
  /** Auction id → exchangeable flag */
  exchangeableOf: (id: number) => boolean | undefined;
  /** productId → bids offered on exchange (learned from past wins) */
  exchangeRateOf: (productId: number) => number | undefined;
  cfg: StrategyConfig;
  mode: ModeState;
  /** Upper bound on concurrent active fights */
  maxConcurrent?: number;
}

export type Decision =
  | { kind: 'book';     auctionId: number; count: number; reason: string }
  | { kind: 'cancel';   auctionId: number;                 reason: string }
  | { kind: 'exchange'; auctionId: number; orderId: string; reason: string }
  | { kind: 'alert';    level: 'good' | 'warn' | 'bad' | 'info'; text: string; linkId?: number };

export interface DecisionResult {
  decisions: Decision[];
  /** Next mode state — pass back on the next tick (hysteresis, focus pick) */
  nextMode: ModeState;
  /** The dedupe-losers we explicitly skipped (informational, used by UI) */
  duplicates: Set<number>;
  /** Focus pick for this tick (null if not focusing) */
  focusKeepId: number | null;
}

// ---------- helpers ----------

function packInfoOf(a: DealDashAuction, ctx: DecisionContext): { pack: boolean; packSize: number } {
  const pack = isPack(ctx.categoryOf(a.id));
  const packSize = pack ? packSizeFromTitle(a.title) : 0;
  return { pack, packSize };
}

function iAmIn(a: DealDashAuction): boolean {
  return a.bidsBooked > 0 || a.bidsSpent > 0;
}

// ---------- main ----------

export function decide(ctx: DecisionContext): DecisionResult {
  const decisions: Decision[] = [];
  const duplicates = new Set<number>();
  const { cfg, mode } = ctx;

  // ---------- 1. Balance mode transitions ----------
  const balanceT = applyBalance(mode.balance, ctx.bidBalance);
  const nextBalance = balanceT.next;
  if (balanceT.event === 'entered') {
    decisions.push({ kind: 'alert', level: 'warn', text: `🪫 LOW BALANCE ENTERED (${ctx.bidBalance} ≤ ${nextBalance.enterAt}): acquire+focus mode ON` });
  } else if (balanceT.event === 'exited') {
    decisions.push({ kind: 'alert', level: 'good', text: `🔋 LOW BALANCE EXITED (${ctx.bidBalance} ≥ ${nextBalance.exitAt}): normal mode resumed` });
  }

  const lowBalance = nextBalance.inLow || mode.lifeSavingMode;
  const acquireMode = mode.exchangeableOnly || lowBalance;

  // ---------- 2. Force-exit: non-pack committed fights below rebook floor ----------
  for (const a of ctx.auctions) {
    if (a.bidsBooked <= 0) continue;
    const { pack } = packInfoOf(a, ctx);
    if (pack) continue;
    const projected = projectedProfit(a, ctx.marketOf(a), cfg, false);
    if (projected == null) continue;
    if (projected < cfg.rebookFloor) {
      decisions.push({
        kind: 'cancel', auctionId: a.id,
        reason: `force-exit: projected $${projected.toFixed(2)} < $${cfg.rebookFloor}`,
      });
    }
  }

  // ---------- 3. Pack overpriced: abandon packs above the $/bid ceiling ----------
  for (const a of ctx.auctions) {
    if (a.bidsBooked <= 0) continue;
    const { pack, packSize } = packInfoOf(a, ctx);
    if (!pack || packSize <= 0) continue;
    const effPerBid = packCostPerBid(a, cfg);
    if (effPerBid > cfg.maxPackPerBid) {
      decisions.push({
        kind: 'cancel', auctionId: a.id,
        reason: `pack overpriced: $${effPerBid.toFixed(4)}/bid > $${cfg.maxPackPerBid}/bid`,
      });
    }
  }

  // ---------- 4. Low-balance: dedup by productId (keep highest sunk cost) ----------
  if (lowBalance) {
    const stake = ctx.auctions.filter(iAmIn);
    const byProduct = new Map<number, DealDashAuction>();
    const standalone: DealDashAuction[] = [];
    for (const a of stake) {
      const pid = ctx.productIdOf(a.id);
      if (!pid) { standalone.push(a); continue; }
      const prev = byProduct.get(pid);
      if (!prev || a.bidsSpent > prev.bidsSpent) byProduct.set(pid, a);
    }
    for (const a of stake) {
      const pid = ctx.productIdOf(a.id);
      if (!pid) continue;
      const winner = byProduct.get(pid);
      if (winner && winner.id !== a.id) {
        duplicates.add(a.id);
        if (a.bidsBooked > 0) {
          decisions.push({
            kind: 'cancel', auctionId: a.id,
            reason: `dup-product: ${winner.id} has more sunk cost`,
          });
        }
      }
    }
  }

  // ---------- 5. Focus pick via rejoinScore ----------
  let focusKeepId: number | null = null;
  if (lowBalance) {
    const contenders = ctx.auctions
      .filter(iAmIn)
      .filter(a => !duplicates.has(a.id));
    if (contenders.length) {
      const scored = contenders.map(a => {
        const { pack } = packInfoOf(a, ctx);
        const score = rejoinScore(a, ctx.marketOf(a), cfg, pack);
        return { a, score };
      }).sort((x, y) => {
        if (x.score.pack !== y.score.pack) return x.score.pack ? -1 : 1;
        return y.score.score - x.score.score;
      });
      focusKeepId = scored[0].a.id;
    }
    // Cancel every non-focus committed auction we haven't already cancelled
    const alreadyCancelled = new Set(decisions.filter(d => d.kind === 'cancel').map(d => (d as Extract<Decision, { kind: 'cancel' }>).auctionId));
    for (const a of contenders) {
      if (a.id === focusKeepId) continue;
      if (a.bidsBooked <= 0) continue;
      if (alreadyCancelled.has(a.id)) continue;
      decisions.push({
        kind: 'cancel', auctionId: a.id,
        reason: `focus: keeping only ${focusKeepId}`,
      });
    }
  }

  // ---------- 6. Auto-cancel: too many bidders on a non-pack fight ----------
  // Non-pack cancelAt = 3 (4+ bidders); pack = 4 (5+ bidders)
  for (const a of ctx.auctions) {
    if (a.bidsBooked <= 0) continue;
    const { pack } = packInfoOf(a, ctx);
    const cancelAt = pack ? 4 : 3;
    if (a.othersBidding >= cancelAt) {
      // Already in cancel list? Skip.
      if (decisions.some(d => d.kind === 'cancel' && d.auctionId === a.id)) continue;
      decisions.push({
        kind: 'cancel', auctionId: a.id,
        reason: `too many bidders (${a.othersBidding + 1})`,
      });
    }
  }

  // ---------- 7. Rebook committed queues ----------
  // In low-balance mode, the rebook path is LOCKED to focusKeepId.
  const rebookBatch = 5;
  const packRebookBatch = 20;
  for (const a of ctx.auctions) {
    if (!iAmIn(a)) continue;
    if (a.bidsBooked > 4) continue; // queue not shallow enough to top up
    // Skip if we just cancelled this auction
    if (decisions.some(d => d.kind === 'cancel' && d.auctionId === a.id)) continue;
    if (lowBalance && focusKeepId !== null && a.id !== focusKeepId) continue;
    const { pack } = packInfoOf(a, ctx);
    const cancelAt = pack ? 4 : 3;
    if (a.othersBidding >= cancelAt) continue;
    const batch = pack ? packRebookBatch : rebookBatch;
    if (ctx.bidBalance < batch) continue;
    if (pack) {
      decisions.push({ kind: 'book', auctionId: a.id, count: batch, reason: 'pack rebook' });
    } else {
      // Non-pack: profit-floor gate
      const projected = projectedProfit(a, ctx.marketOf(a), cfg, false);
      if (projected != null && projected < cfg.rebookFloor) continue;
      decisions.push({ kind: 'book', auctionId: a.id, count: batch, reason: `${a.bidders}-way rebook` });
    }
  }

  // ---------- 8. New entries ----------
  if (!mode.stopLoss) {
    // Count current active fights for concurrency cap
    const activeCount = ctx.auctions.filter(iAmIn).length;
    const concurrencyCapHit = activeCount >= (ctx.maxConcurrent ?? 5);

    // Track same-product cooldown for this tick
    const productChosen = new Map<number, number>();
    for (const a of ctx.auctions.filter(iAmIn)) {
      const pid = ctx.productIdOf(a.id);
      if (pid) productChosen.set(pid, a.id);
    }

    for (const a of ctx.auctions) {
      if (iAmIn(a)) continue;
      if (a.bidders > 2) continue; // only jump in on quiet auctions
      if (concurrencyCapHit) break;
      if (mode.lockedProductIds.has(ctx.productIdOf(a.id) ?? -1)) continue;

      // Same-product cooldown — don't open a second front on an identical product
      const pid = ctx.productIdOf(a.id);
      if (pid && productChosen.has(pid) && productChosen.get(pid) !== a.id) continue;

      const { pack } = packInfoOf(a, ctx);

      // Survival mode: only 2-bidder packs
      if (lowBalance) {
        if (!pack) continue;
        if (a.bidders !== 2) continue;
      } else if (acquireMode) {
        // Manual ExchangeOnly above 1k: packs + exchangeables with known rate
        const isExch = ctx.exchangeableOf(a.id) === true;
        const knownRate = pid ? ctx.exchangeRateOf(pid) : undefined;
        if (!pack && !(isExch && knownRate != null)) continue;
      }

      // Profitability gate (non-pack)
      if (!pack) {
        const status = profitability(a, ctx.marketOf(a), cfg, false, 20);
        if (status !== 'profit') continue;
      }

      const entryCount = a.bidders === 2 ? 2 : 1;
      if (ctx.bidBalance - entryCount < 50) continue; // balance floor
      decisions.push({
        kind: 'book', auctionId: a.id, count: entryCount,
        reason: pack ? `pack entry (${a.bidders}-bidder)` : `${a.bidders}-bidder entry`,
      });
      if (pid) productChosen.set(pid, a.id);
    }
  }

  return {
    decisions,
    nextMode: { ...mode, balance: nextBalance, focusKeepId },
    duplicates,
    focusKeepId,
  };
}
