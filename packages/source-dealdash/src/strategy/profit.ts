/**
 * Pure profit math for DealDash. No I/O, no globals — every function is a
 * deterministic transform you can prove correct with a unit test. The
 * vendored TUI calls these (eventually) instead of computing inline.
 *
 * Key concepts:
 *   - effective $/bid acquired = total_spent / pack_size  (packs only)
 *   - resale value     = pack_size × store_rate (pack) or market mean (item)
 *   - projected profit = resale_value − total_spent
 *   - non-pack entry floor scales with bidder count: base + 50 × extras
 */

import type { DealDashAuction, MarketEntry, ResaleValue, StrategyConfig } from '../types.js';

export function isPack(category: string | undefined): boolean {
  return category === 'Packs';
}

/**
 * Parse "850 Bid Pack!", "ROYALTY ONLY: Special Blooming Bargains 9682
 * Bid Pack!", "+ 1600 Bids" etc. Returns 0 if no number can be extracted.
 */
export function packSizeFromTitle(title: string): number {
  if (!title) return 0;
  // Try common patterns from cheapest to richest
  const patterns = [
    /\b(\d{2,5})\s*Bid\s*Pack/i,
    /\+\s*(\d{2,5})\s*Bids/i,
    /\b(\d{2,5})\s*Bids/i,
  ];
  for (const re of patterns) {
    const m = title.match(re);
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Total $ we've spent on this auction (bids placed × per-bid + current price). */
export function totalSpent(a: DealDashAuction, cfg: StrategyConfig): number {
  return a.bidsSpent * cfg.costPerBid + Number(a.ddPrice || 0);
}

/**
 * Effective dollar cost per bid acquired through this pack auction.
 * Returns 0 for non-packs or unparseable titles.
 */
export function packCostPerBid(a: DealDashAuction, cfg: StrategyConfig): number {
  const sz = packSizeFromTitle(a.title);
  if (sz <= 0) return 0;
  return totalSpent(a, cfg) / sz;
}

/**
 * Resale / exchange value of an auction.
 * - Pack: pack_size × store rate
 * - Item: trimmed mean of market listings (falls back to median, then min)
 * Returns null if we can't determine a value.
 */
export function getResaleValue(
  a: DealDashAuction,
  market: MarketEntry | null | undefined,
  cfg: StrategyConfig,
  pack: boolean,
): ResaleValue | null {
  if (pack) {
    const sz = packSizeFromTitle(a.title);
    if (sz <= 0) return null;
    return { value: sz * cfg.storeBidPrice, source: 'pack' };
  }
  if (!market || market.count === 0) return null;
  const value = market.mean ?? market.median ?? market.min;
  return { value, source: 'market' };
}

/** Profit floor for opening a NEW non-pack fight — scales with bidders. */
export function nonPackEntryFloor(bidders: number, cfg: StrategyConfig): number {
  return cfg.nonPackBaseFloor + Math.max(0, bidders - 1) * 50;
}

/** Projected profit (resale value − sunk cost). */
export function projectedProfit(
  a: DealDashAuction,
  market: MarketEntry | null | undefined,
  cfg: StrategyConfig,
  pack: boolean,
): number | null {
  const v = getResaleValue(a, market, cfg, pack);
  if (!v) return null;
  return v.value - totalSpent(a, cfg);
}

/** Profitability classification used by the auto-cancel + new-entry gates. */
export type Profitability = 'profit' | 'loss' | 'unknown';

export function profitability(
  a: DealDashAuction,
  market: MarketEntry | null | undefined,
  cfg: StrategyConfig,
  pack: boolean,
  packMinProfit: number,
): Profitability {
  if (pack) {
    const profit = projectedProfit(a, market, cfg, true);
    if (profit == null) return 'unknown';
    return profit >= packMinProfit ? 'profit' : 'loss';
  }
  if (!market) return 'unknown';
  if (market.count === 0) return 'loss';
  const profit = projectedProfit(a, market, cfg, false);
  if (profit == null) return 'loss';
  return profit >= nonPackEntryFloor(a.bidders, cfg) ? 'profit' : 'loss';
}
