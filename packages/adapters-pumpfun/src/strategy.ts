/**
 * Pump.fun entry / exit strategy (PRD §17, §20.4).
 *
 * Pure functions — no I/O, no side effects. All logic is deterministic
 * given the inputs so it is trivially testable without mocks.
 *
 * Strategy overview
 * -----------------
 * Entry: token must be on the bonding curve (new_launch or bonding_curve
 *   lifecycle), recently created, and within the target market-cap band.
 *   Only one position per mint, and we cap total concurrent positions.
 *
 * Exit: we track positions by mint. Each tick we re-check the current
 *   market cap against four exit triggers:
 *   - take_profit   : market cap grew ≥ takeProfitPct above entry cap
 *   - stop_loss     : market cap fell ≥ stopLossPct below entry cap
 *   - time_stop     : position held longer than maxHoldMinutes
 *   - graduation    : market cap crossed the graduation threshold
 *                     (token will migrate off the bonding curve — we
 *                     exit before execution risk increases)
 */

import type { PumpFunTokenCandidate } from './discovery.js';

// ─── Public types ─────────────────────────────────────────────────

export interface PumpPosition {
  mint: string;
  name: string;
  symbol: string;
  entryMarketCapUsd: number;
  /** Unix epoch milliseconds when the position was opened. */
  entryAt: number;
  /** SOL spent (not lamports). */
  solSpent: number;
  /** Raw token units received (stored as number for JSON serialisation;
   *  cast to bigint when passing to arithmetic helpers). */
  tokenBalance?: number;
  /** True once a partial exit has fired on this position. Prevents
   *  re-firing the partial sell on every subsequent tick. The remaining
   *  tokenBalance reflects what's left after the partial. */
  partialExitDone?: boolean;
  /** Latest fetched USD market cap. Populated by the daemon worker
   *  during its exit-check pass; absent until the first successful
   *  status fetch. Used by UIs to compute P&L vs entry. */
  currentMarketCapUsd?: number;
  /** Rolling history of mcap samples for sparkline rendering, oldest
   *  first, capped to MCAP_SAMPLE_LIMIT. */
  mcapSamples?: number[];
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'time_stop' | 'graduation';

export interface EntryConfig {
  /** Minimum market cap to consider entering. Default: 5000 USD. */
  minMarketCapUsd?: number;
  /** Maximum market cap to consider entering. Default: 25000 USD. */
  maxMarketCapUsd?: number;
  /** Only enter tokens younger than this (minutes). Default: 5. */
  maxAgeMinutes?: number;
  /** Skip tokens younger than this (minutes). Forces a minimum window
   *  for trade history to accumulate. Default: 2. */
  minAgeMinutes?: number;
  /** Maximum open positions at any one time. Default: 3. */
  maxPositions?: number;
  /** Skip dead-on-arrival tokens with no chat engagement. The pump.fun
   *  reply count is the cheapest "is anyone watching this" signal.
   *  Default: 3 (filters most rugged-at-launch dust). */
  minReplyCount?: number;
  /** Skip tokens whose bonding curve hasn't moved off genesis. New
   *  pump.fun curves start at ~30 SOL virtual reserves; any buy increases
   *  it. Setting this to >30 requires *someone* to have already bought.
   *  Default: 32 (~2 SOL of cumulative buys, roughly $360 traded). */
  minVirtualSolReserves?: number;
  /** Bonding-curve progress floor (% filled, 0–100). pump.fun curves
   *  graduate at ~85 SOL of real buys; this is `(reserves - 30) / 85`.
   *  Default: 10 — skip the dust band where bots/insiders dominate. */
  minCurveProgressPct?: number;
  /** Bonding-curve progress ceiling (% filled). Above this we're in the
   *  near-graduation crowded zone where price often dumps post-migration.
   *  Default: 80. */
  maxCurveProgressPct?: number;
}

/** Genesis virtual SOL reserves for a new pump.fun bonding curve. The
 *  curve grows from this point as real SOL is bought into it (bonded). */
const PUMPFUN_GENESIS_SOL_RESERVES = 30;
/** SOL needed to graduate from the bonding curve to the AMM (Raydium /
 *  PumpSwap). Curve progress is normalised against this number. */
const PUMPFUN_GRADUATION_SOL_DELTA = 85;

/** Compute the bonding-curve progress as a percentage 0..100, where 0 is
 *  fresh genesis (no buys) and 100 is graduation. Returns null when the
 *  candidate has no virtualSolReserves field (already migrated/graduated). */
export function curveProgressPct(virtualSolReserves: number | null): number | null {
  if (virtualSolReserves == null || !Number.isFinite(virtualSolReserves)) return null;
  return Math.max(0, Math.min(100,
    ((virtualSolReserves - PUMPFUN_GENESIS_SOL_RESERVES) / PUMPFUN_GRADUATION_SOL_DELTA) * 100,
  ));
}

export interface ExitConfig {
  /** Sell when market cap is this fraction above entry. Default: 0.8 (+80%). */
  takeProfitPct?: number;
  /** Sell when market cap is this fraction below entry. Default: 0.45 (−45%). */
  stopLossPct?: number;
  /** Maximum hold time in minutes. Default: 20. */
  maxHoldMinutes?: number;
  /** Exit when market cap exceeds this (graduation imminent). Default: 55000. */
  graduationCapUsd?: number;
}

// ─── Default values ───────────────────────────────────────────────

/** Merge `overrides` over `defaults`, but only for keys whose override
 *  value is not undefined. The naive `{ ...defaults, ...overrides }`
 *  spread overrides defaults with explicit `undefined` when the caller
 *  builds `overrides` from optional env vars — that silently zeroed out
 *  every threshold and made checkExit return null for every position. */
function mergeDefined<T extends Record<string, unknown>>(defaults: T, overrides?: Partial<T>): T {
  if (!overrides) return defaults;
  const out = { ...defaults };
  for (const k of Object.keys(overrides) as (keyof T)[]) {
    const v = overrides[k];
    if (v !== undefined) out[k] = v as T[keyof T];
  }
  return out;
}


const DEFAULT_ENTRY: Required<EntryConfig> = {
  // Slightly higher floor avoids the rugged-at-launch dust where price
  // discovery hasn't started; ceiling stays where late-stage bonding
  // curves still have meaningful upside.
  minMarketCapUsd: 5_000,
  maxMarketCapUsd: 25_000,
  maxAgeMinutes: 10,
  minAgeMinutes: 2,
  maxPositions: 3,
  // History filters — the previous defaults entered tokens with zero
  // trades since launch ("no history" tokens), most of which immediately
  // dumped. Require some signal that a token is alive before entering.
  minReplyCount: 3,
  minVirtualSolReserves: 32,
  // Curve-progress band: skip the bot-dominated dust band (<10%) and
  // the post-migration crowd (>80%).
  minCurveProgressPct: 10,
  maxCurveProgressPct: 80,
};

const DEFAULT_EXIT: Required<ExitConfig> = {
  // Tightened from prior 0.8 / 0.45 / 20 / 55k. The previous defaults
  // let positions sit at -36% for half an hour, which observation shows
  // is mostly bag-holding rather than waiting for a re-pump. Faster cuts
  // and lower take-profits match the realistic distribution where most
  // tokens don't 2x.
  takeProfitPct: 0.5,
  stopLossPct: 0.3,
  maxHoldMinutes: 10,
  graduationCapUsd: 55_000,
};

// ─── Entry decision ───────────────────────────────────────────────

/**
 * Decide whether to open a new position on a candidate token.
 *
 * Returns true only when ALL of the following hold:
 *   1. We have fewer than `maxPositions` open positions.
 *   2. No existing position with the same mint is open.
 *   3. The token's lifecycle is 'new_launch' or 'bonding_curve'.
 *   4. The token's age (since creation) is ≤ `maxAgeMinutes`.
 *   5. The token's market cap is within [minMarketCapUsd, maxMarketCapUsd].
 *
 * @param candidate      Token candidate from PumpFunDiscoveryAdapter.discover()
 * @param openPositions  Currently open positions
 * @param config         Entry configuration overrides
 * @param nowMs          Current time in ms (default: Date.now())
 */
export function shouldEnter(
  candidate: PumpFunTokenCandidate,
  openPositions: PumpPosition[],
  config?: EntryConfig,
  nowMs?: number,
): boolean {
  const cfg = mergeDefined(DEFAULT_ENTRY, config);
  const now = nowMs ?? Date.now();

  // Max concurrent positions.
  if (openPositions.length >= cfg.maxPositions) return false;

  // No duplicate positions.
  if (openPositions.some((p) => p.mint === candidate.mint)) return false;

  // Only bonding-curve stages — we can actually trade against the curve.
  if (candidate.lifecycle !== 'new_launch' && candidate.lifecycle !== 'bonding_curve') return false;

  // Age gate. Reject too-young (no history yet) AND too-old (missed
  // momentum window) candidates.
  const ageMinutes = (now - candidate.createdAtMs) / 60_000;
  if (ageMinutes < cfg.minAgeMinutes) return false;
  if (ageMinutes > cfg.maxAgeMinutes) return false;

  // Market cap range.
  if (candidate.marketCapUsd < cfg.minMarketCapUsd) return false;
  if (candidate.marketCapUsd > cfg.maxMarketCapUsd) return false;

  // History gates — skip tokens with no community / no trades since
  // launch. These would otherwise keep us bag-holding new launches that
  // nobody else cared enough to buy.
  if (candidate.replyCount < cfg.minReplyCount) return false;
  if (candidate.virtualSolReserves != null
      && candidate.virtualSolReserves < cfg.minVirtualSolReserves) return false;

  // Curve-progress band gate.
  const progress = curveProgressPct(candidate.virtualSolReserves);
  if (progress != null) {
    if (progress < cfg.minCurveProgressPct) return false;
    if (progress > cfg.maxCurveProgressPct) return false;
  }

  return true;
}

// ─── Exit decision ────────────────────────────────────────────────

/**
 * Check whether an open position should be exited.
 *
 * @param position           The open position to evaluate.
 * @param currentMarketCapUsd The token's current USD market cap.
 * @param config             Exit configuration overrides.
 * @param nowMs              Current time in ms (default: Date.now()).
 * @returns                  An ExitReason if we should exit, or null to hold.
 */
export function checkExit(
  position: PumpPosition,
  currentMarketCapUsd: number,
  config?: ExitConfig,
  nowMs?: number,
): ExitReason | null {
  const cfg = mergeDefined(DEFAULT_EXIT, config);
  const now = nowMs ?? Date.now();

  // Graduation: market cap above graduation threshold — exit before migration.
  if (currentMarketCapUsd >= cfg.graduationCapUsd) return 'graduation';

  // Take profit: market cap rose enough relative to entry.
  const gainFraction = (currentMarketCapUsd - position.entryMarketCapUsd) / position.entryMarketCapUsd;
  if (gainFraction >= cfg.takeProfitPct) return 'take_profit';

  // Stop loss: market cap fell enough relative to entry.
  const lossFraction = (position.entryMarketCapUsd - currentMarketCapUsd) / position.entryMarketCapUsd;
  if (lossFraction >= cfg.stopLossPct) return 'stop_loss';

  // Time stop: held too long.
  const heldMinutes = (now - position.entryAt) / 60_000;
  if (heldMinutes >= cfg.maxHoldMinutes) return 'time_stop';

  return null;
}
