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
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'time_stop' | 'graduation';

export interface EntryConfig {
  /** Minimum market cap to consider entering. Default: 3000 USD. */
  minMarketCapUsd?: number;
  /** Maximum market cap to consider entering. Default: 25000 USD. */
  maxMarketCapUsd?: number;
  /** Only enter tokens younger than this (minutes). Default: 5. */
  maxAgeMinutes?: number;
  /** Maximum open positions at any one time. Default: 3. */
  maxPositions?: number;
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

const DEFAULT_ENTRY: Required<EntryConfig> = {
  minMarketCapUsd: 3_000,
  maxMarketCapUsd: 25_000,
  maxAgeMinutes: 5,
  maxPositions: 3,
};

const DEFAULT_EXIT: Required<ExitConfig> = {
  takeProfitPct: 0.8,
  stopLossPct: 0.45,
  maxHoldMinutes: 20,
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
  const cfg = { ...DEFAULT_ENTRY, ...config };
  const now = nowMs ?? Date.now();

  // Max concurrent positions.
  if (openPositions.length >= cfg.maxPositions) return false;

  // No duplicate positions.
  if (openPositions.some((p) => p.mint === candidate.mint)) return false;

  // Only bonding-curve stages — we can actually trade against the curve.
  if (candidate.lifecycle !== 'new_launch' && candidate.lifecycle !== 'bonding_curve') return false;

  // Age gate.
  const ageMinutes = (now - candidate.createdAtMs) / 60_000;
  if (ageMinutes > cfg.maxAgeMinutes) return false;

  // Market cap range.
  if (candidate.marketCapUsd < cfg.minMarketCapUsd) return false;
  if (candidate.marketCapUsd > cfg.maxMarketCapUsd) return false;

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
  const cfg = { ...DEFAULT_EXIT, ...config };
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
