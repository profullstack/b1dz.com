/**
 * Shared helpers for the deterministic strategy plugins.
 *
 * Strategies are signals-only and asset-agnostic: they read the MarketSnapshot
 * stream and emit Signal objects. The engine owns sizing, risk, session gating,
 * and execution — a strategy cannot tell (and must not care) whether the series
 * is BTC-USD on Kraken or AAPL on Alpaca. See docs/prd-equities-v1.md §8.
 */
import type { MarketSnapshot } from '@b1dz/core';

/** Mid price of a snapshot; falls back to whichever side is present. */
export function mid(snap: MarketSnapshot): number {
  if (snap.bid > 0 && snap.ask > 0) return (snap.bid + snap.ask) / 2;
  return snap.bid || snap.ask || 0;
}

/**
 * Build the chronological mid-price series for an evaluation: the history
 * (oldest → newest) with the current snapshot appended.
 */
export function midSeries(snap: MarketSnapshot, history: MarketSnapshot[]): number[] {
  return [...history.map(mid), mid(snap)];
}

/** Clamp a raw score into the Signal strength range [0, 1]. */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
