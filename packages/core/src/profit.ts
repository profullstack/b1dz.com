/**
 * Common profit / risk math shared across all sources.
 *
 * Each source produces its own `costNow` and `projectedReturn`; this module
 * turns those into uniform metrics so the UI and rules engine can rank/filter
 * opportunities without knowing what they are.
 */

import type { Opportunity } from './types.js';

export function profit(o: Opportunity): number {
  return o.projectedReturn - o.costNow;
}

export function roi(o: Opportunity): number {
  return o.costNow > 0 ? profit(o) / o.costNow : 0;
}

/** Risk-adjusted expected value: profit × confidence. */
export function expectedValue(o: Opportunity): number {
  return profit(o) * o.confidence;
}

/** Project per-unit cost (bids, shares, etc.) given a unit count from metadata. */
export function costPerUnit(o: Opportunity, units: number): number {
  return units > 0 ? o.costNow / units : 0;
}

/**
 * Score an opportunity for ranking. Higher is better.
 * Penalizes low confidence and looming expiry.
 */
export function score(o: Opportunity, now = Date.now()): number {
  const ev = expectedValue(o);
  if (!o.expiresAt) return ev;
  const minutesLeft = Math.max(0, (o.expiresAt - now) / 60_000);
  // Tiny urgency multiplier — opportunities expiring within an hour get a small bump
  const urgency = minutesLeft < 60 ? 1.1 : 1;
  return ev * urgency;
}
