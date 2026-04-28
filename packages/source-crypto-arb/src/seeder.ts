/**
 * Auto-seeder for inventory-arb.
 *
 * The arb engine can only execute when it already holds the base asset on
 * the sell-side exchange (you sell there, buy cheaper on the other venue
 * to rebalance — delta-neutral, no on-chain transfer risk). When a
 * profitable opportunity appears but inventory is 0, the seeder places
 * ONE market buy of the base asset on the sell-side exchange using
 * available stablecoin balance. Subsequent arb cycles then execute
 * normally and, over time, earn back the seed cost.
 *
 * Hard guarantees (enforced by this module — see tests):
 *   1. Seeding NEVER sells existing holdings. Only stable quote balance
 *      (USDC → USDT → USD priority) is consumed.
 *   2. Per-pair budget cap: SEED_PER_PAIR_USD.
 *   3. Global budget cap: SEED_GLOBAL_USD across all pairs combined.
 *   4. Per-pair cooldown: SEED_COOLDOWN_MS between seeds on the same pair
 *      (on the same sell-venue) — stops thrashing if a spread flickers.
 *   5. Circuit breaker: a pair that has been seeded but hasn't realized
 *      ≥ SEED_PROFIT_RATIO × its seed cost in arb profit within
 *      SEED_EVAL_WINDOW_MS is paused from re-seeding for SEED_PAUSE_MS.
 *      This kills "keep buying retail because a spread briefly showed up".
 *   6. Only executes when tradingEnabled is true (same kill switch as the
 *      rest of the system — no new UI).
 *
 * The decision helpers are pure functions so tests can drive them without
 * hitting real exchange APIs.
 */

import type { ArbStrategyId } from './index.js';

/** Tunables (env-overridable for operators who want more/less aggression). */
export const SEED_PER_PAIR_USD = Number(process.env.ARB_AUTO_SEED_PER_PAIR_USD ?? 50);
export const SEED_GLOBAL_USD = Number(process.env.ARB_AUTO_SEED_GLOBAL_USD ?? 200);
export const SEED_COOLDOWN_MS = Number(process.env.ARB_AUTO_SEED_COOLDOWN_MS ?? 30 * 60_000);
/** Window over which we judge a seeded pair's profitability. */
export const SEED_EVAL_WINDOW_MS = Number(process.env.ARB_AUTO_SEED_EVAL_WINDOW_MS ?? 24 * 60 * 60_000);
/** Pair is paused this long after failing the eval check. */
export const SEED_PAUSE_MS = Number(process.env.ARB_AUTO_SEED_PAUSE_MS ?? 7 * 24 * 60 * 60_000);
/** Seed must earn back at least this multiple of its cost. 1.0 = break-even. */
export const SEED_PROFIT_RATIO = Number(process.env.ARB_AUTO_SEED_PROFIT_RATIO ?? 1.5);
/** Minimum seed size — below this we skip (exchange min-notional + fees make it silly). */
export const SEED_MIN_USD = Number(process.env.ARB_AUTO_SEED_MIN_USD ?? 10);
/** Stable quote assets we'll spend to seed, in priority order. */
export const STABLE_PRIORITY = ['USDC', 'USDT', 'USD', 'ZUSD'] as const;

/** Key used to store seeder state in the crypto-arb payload. */
export const SEED_STATE_PAYLOAD_KEY = 'arbSeedState';

export interface SeedLedgerEntry {
  /** e.g. "binance-us:DOGE-USD" — seed is pinned to the SELL-side exchange
   *  and the pair, because inventory is exchange-local. */
  key: string;
  /** Last time we placed a seed order on this pair/venue (ms). */
  lastSeededAtMs: number;
  /** USD cost of the most recent seed (order notional, pre-fees). */
  lastSeedCostUsd: number;
  /** Running total USD cost of all seeds on this pair/venue (never decays). */
  totalSeedCostUsd: number;
  /** Pause-until timestamp. If > now, re-seeding is blocked for this pair. */
  pausedUntilMs: number;
  /** Human-readable reason for the current pause (for TUI display/logs). */
  pauseReason?: string;
}

export interface SeedState {
  /** Per-(exchange, pair) ledger. */
  entries: Record<string, SeedLedgerEntry>;
  /** Total lifetime seed spend across all pairs. Monotonic — we don't decay
   *  this because a user who's already parked $200 in seed inventory doesn't
   *  need the daemon to decide to park another $200 "because it's been a
   *  while". They can manually reset if they truly want to re-seed. */
  totalSeedCostUsd: number;
}

export function emptySeedState(): SeedState {
  return { entries: {}, totalSeedCostUsd: 0 };
}

/** Safely coerce an arbitrary persisted value back into a SeedState. */
export function normalizeSeedState(raw: unknown): SeedState {
  if (!raw || typeof raw !== 'object') return emptySeedState();
  const obj = raw as Partial<SeedState>;
  const entries: Record<string, SeedLedgerEntry> = {};
  if (obj.entries && typeof obj.entries === 'object') {
    for (const [k, v] of Object.entries(obj.entries as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Partial<SeedLedgerEntry>;
      if (typeof e.key !== 'string') continue;
      // Coerce numerics robustly — persisted JSON may have stringified numbers
      // (e.g. after a round-trip through Postgres `numeric` or `text` columns).
      const numOr0 = (x: unknown): number => {
        const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
        return Number.isFinite(n) ? n : 0;
      };
      entries[k] = {
        key: e.key,
        lastSeededAtMs: numOr0(e.lastSeededAtMs),
        lastSeedCostUsd: numOr0(e.lastSeedCostUsd),
        totalSeedCostUsd: numOr0(e.totalSeedCostUsd),
        pausedUntilMs: numOr0(e.pausedUntilMs),
        pauseReason: typeof e.pauseReason === 'string' ? e.pauseReason : undefined,
      };
    }
  }
  const totalNum = typeof obj.totalSeedCostUsd === 'number'
    ? obj.totalSeedCostUsd
    : typeof obj.totalSeedCostUsd === 'string'
      ? Number(obj.totalSeedCostUsd)
      : NaN;
  const totalSeedCostUsd = Number.isFinite(totalNum) ? totalNum : 0;
  return { entries, totalSeedCostUsd };
}

export type SeedDecisionKind =
  /** Go: place a market buy of `sizeUsd` on `exchange` for `pair`. */
  | { kind: 'seed'; exchange: string; pair: string; sizeUsd: number }
  /** No-op: seeding is not required (inventory already exists). */
  | { kind: 'inventory-ready' }
  /** Skipped: per-pair cooldown active. */
  | { kind: 'cooldown'; remainingMs: number }
  /** Skipped: pair is circuit-broken until `untilMs`. */
  | { kind: 'paused'; untilMs: number; reason: string }
  /** Skipped: per-pair budget already exhausted. */
  | { kind: 'budget-pair-exhausted'; spentUsd: number; capUsd: number }
  /** Skipped: global budget exhausted. */
  | { kind: 'budget-global-exhausted'; spentUsd: number; capUsd: number }
  /** Skipped: not enough stable balance on the target exchange. */
  | { kind: 'no-stable-balance'; available: number; wanted: number }
  /** Skipped: resulting seed would be below SEED_MIN_USD. */
  | { kind: 'seed-too-small'; sizeUsd: number }
  /** Skipped: seed execution is disabled (trading kill switch, etc.). */
  | { kind: 'disabled'; reason: string };

export interface SeedDecisionInput {
  /** "binance-us:DOGE-USD" */
  key: string;
  /** Sell-side exchange where we need inventory. */
  exchange: string;
  /** e.g. "DOGE-USD" */
  pair: string;
  /** Current inventory of the base asset on the sell-side exchange. */
  currentBaseInventory: number;
  /** Per-exchange stable quote balance (sum of USDC+USDT+USD). */
  stableBalanceOnExchange: number;
  /** Wallclock "now" in ms (injected for testability). */
  nowMs: number;
  /** Trading kill-switch (same toggle as the rest of the system). */
  tradingEnabled: boolean;
  /** Current seed state (ledger + totals). */
  state: SeedState;
  /** Min base-inventory USD below which we consider the venue empty for arb
   *  purposes. Default mirrors MIN_EXECUTABLE_USD elsewhere in the codebase
   *  (see source-crypto-arb/index.ts). */
  minInventoryUsd?: number;
  /** Current buy-leg price (needed to convert inventory-volume → USD). */
  refPriceUsd: number;
}

export function decideSeed(input: SeedDecisionInput): SeedDecisionKind {
  const minInventoryUsd = input.minInventoryUsd ?? 5;

  if (!input.tradingEnabled) {
    return { kind: 'disabled', reason: 'trading disabled' };
  }

  const currentInventoryUsd = input.currentBaseInventory * input.refPriceUsd;
  if (Number.isFinite(currentInventoryUsd) && currentInventoryUsd >= minInventoryUsd) {
    return { kind: 'inventory-ready' };
  }

  const entry = input.state.entries[input.key];
  if (entry) {
    if (entry.pausedUntilMs > input.nowMs) {
      return {
        kind: 'paused',
        untilMs: entry.pausedUntilMs,
        reason: entry.pauseReason ?? 'circuit breaker',
      };
    }
    const cooldownRemaining = (entry.lastSeededAtMs + SEED_COOLDOWN_MS) - input.nowMs;
    if (cooldownRemaining > 0) {
      return { kind: 'cooldown', remainingMs: cooldownRemaining };
    }
    if (entry.totalSeedCostUsd >= SEED_PER_PAIR_USD) {
      return {
        kind: 'budget-pair-exhausted',
        spentUsd: entry.totalSeedCostUsd,
        capUsd: SEED_PER_PAIR_USD,
      };
    }
  }

  if (input.state.totalSeedCostUsd >= SEED_GLOBAL_USD) {
    return {
      kind: 'budget-global-exhausted',
      spentUsd: input.state.totalSeedCostUsd,
      capUsd: SEED_GLOBAL_USD,
    };
  }

  const pairRemaining = Math.max(0, SEED_PER_PAIR_USD - (entry?.totalSeedCostUsd ?? 0));
  const globalRemaining = Math.max(0, SEED_GLOBAL_USD - input.state.totalSeedCostUsd);
  // Leave a small buffer on stable balance — we never want to drain it
  // completely, since the arb engine itself also needs stables for its own
  // buy legs on subsequent cycles.
  const stableUsable = Math.max(0, input.stableBalanceOnExchange * 0.5);

  const sizeUsd = Math.min(pairRemaining, globalRemaining, stableUsable);

  if (stableUsable < SEED_MIN_USD) {
    return {
      kind: 'no-stable-balance',
      available: input.stableBalanceOnExchange,
      wanted: SEED_MIN_USD,
    };
  }

  if (sizeUsd < SEED_MIN_USD) {
    return { kind: 'seed-too-small', sizeUsd };
  }

  return { kind: 'seed', exchange: input.exchange, pair: input.pair, sizeUsd };
}

/** Update the ledger after a successful seed order. Pure — returns a new state. */
export function recordSeed(state: SeedState, args: {
  key: string;
  costUsd: number;
  nowMs: number;
}): SeedState {
  const prev = state.entries[args.key];
  const entry: SeedLedgerEntry = {
    key: args.key,
    lastSeededAtMs: args.nowMs,
    lastSeedCostUsd: args.costUsd,
    totalSeedCostUsd: (prev?.totalSeedCostUsd ?? 0) + args.costUsd,
    pausedUntilMs: prev?.pausedUntilMs ?? 0,
    pauseReason: prev?.pauseReason,
  };
  return {
    entries: { ...state.entries, [args.key]: entry },
    totalSeedCostUsd: state.totalSeedCostUsd + args.costUsd,
  };
}

/** Circuit-breaker evaluator. Call periodically (e.g. once per tick).
 *  For each seeded entry whose last seed is older than SEED_EVAL_WINDOW_MS
 *  and hasn't produced ≥ SEED_PROFIT_RATIO × its cost in arb profit, pause
 *  re-seeding for SEED_PAUSE_MS. Pure — returns a new state. */
export function evaluateCircuitBreakers(
  state: SeedState,
  args: {
    nowMs: number;
    /** Map of key → realized arb profit (USD) attributable to this pair
     *  since `lastSeededAtMs`. Positive numbers are profit, negative are
     *  losses. Caller is responsible for tracking this from closed trades. */
    realizedProfitByKey: Record<string, number>;
  },
): SeedState {
  const nextEntries: Record<string, SeedLedgerEntry> = { ...state.entries };
  let changed = false;
  for (const [key, entry] of Object.entries(state.entries)) {
    if (entry.pausedUntilMs > args.nowMs) continue; // already paused
    const elapsed = args.nowMs - entry.lastSeededAtMs;
    if (elapsed < SEED_EVAL_WINDOW_MS) continue; // too soon to judge
    if (entry.totalSeedCostUsd <= 0) continue; // never seeded meaningfully
    const earned = args.realizedProfitByKey[key] ?? 0;
    const threshold = entry.totalSeedCostUsd * SEED_PROFIT_RATIO;
    if (earned >= threshold) continue; // passed the bar
    nextEntries[key] = {
      ...entry,
      pausedUntilMs: args.nowMs + SEED_PAUSE_MS,
      pauseReason: `earned $${earned.toFixed(2)} of $${threshold.toFixed(2)} target in ${Math.round(elapsed / 3_600_000)}h`,
    };
    changed = true;
  }
  if (!changed) return state;
  return { entries: nextEntries, totalSeedCostUsd: state.totalSeedCostUsd };
}

/** Summarize stable balance from a raw exchange balance map. Used by the
 *  seed decision path so it matches how the arb engine already reads quote
 *  balances (see `quoteBalance` in index.ts). */
export function stableBalanceOf(balance: Record<string, string>): number {
  let sum = 0;
  for (const k of STABLE_PRIORITY) {
    const amt = parseFloat(balance[k] ?? '0');
    if (Number.isFinite(amt) && amt > 0) sum += amt;
  }
  return sum;
}

/** Pick the quote asset we'd spend on `exchange` (priority-ordered).
 *  Returns null if none has enough balance for the requested USD size. */
export function pickStableToSpend(
  balance: Record<string, string>,
  wantUsd: number,
): { asset: string; amount: number } | null {
  for (const k of STABLE_PRIORITY) {
    const amt = parseFloat(balance[k] ?? '0');
    if (Number.isFinite(amt) && amt >= wantUsd) return { asset: k, amount: amt };
  }
  return null;
}

/** Sanity: for an arb-like tuple, the key we use throughout. */
export function seedKey(exchange: string, pair: string): string {
  return `${exchange}:${pair}`;
}

/** Re-export ArbStrategyId so callers don't need a second import path. */
export type { ArbStrategyId };
