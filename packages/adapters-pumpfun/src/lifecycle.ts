/**
 * Pump.fun token lifecycle classification (PRD §14.4, §18).
 *
 * Every Pump.fun token passes through a well-known sequence of states.
 * The strategy engine treats each state very differently, so accurate
 * classification is load-bearing for risk gates in PRD §17 / §20.4.
 */

import type { TokenLifecycle } from '@b1dz/venue-types';

/** Raw input shape we need to classify. Only the subset of the upstream
 *  coin JSON that matters for lifecycle decisions — keeps the classifier
 *  pure and testable without coupling to the full upstream schema. */
export interface PumpFunLifecycleInput {
  /** True when the bonding curve has been filled and migration triggered. */
  complete: boolean;
  /** Raydium pool address populated after migration finishes. */
  raydiumPool?: string | null;
  /** PumpSwap pool address if token routed to PumpSwap instead of Raydium. */
  pumpSwapPool?: string | null;
  /** Unix epoch millis when the token was created. */
  createdAtMs: number;
  /** Unix epoch millis "now" for age calculation — injected for determinism. */
  now?: number;
}

/**
 * Classify a Pump.fun token into one of the canonical lifecycle states.
 *
 * State machine (simplified):
 *   new_launch       - < 1h old, bonding curve not complete yet
 *   bonding_curve    - still on bonding curve, > 1h old
 *   migrating        - bonding curve complete but no pool yet
 *   pumpswap         - migrated to PumpSwap
 *   external_pool    - migrated to Raydium (Pump.fun's default graduation)
 */
export function classifyLifecycle(input: PumpFunLifecycleInput): TokenLifecycle {
  const now = input.now ?? Date.now();
  const ageMs = Math.max(0, now - input.createdAtMs);

  if (input.pumpSwapPool) return 'pumpswap';
  if (input.raydiumPool) return 'external_pool';
  if (input.complete) return 'migrating';
  if (ageMs < 60 * 60 * 1000) return 'new_launch';
  return 'bonding_curve';
}
