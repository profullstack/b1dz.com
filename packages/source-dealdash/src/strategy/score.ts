/**
 * Rejoin / focus scoring — picks "which auction to defend" when we can
 * only afford to fight on one front.
 *
 *   pack score    = (storeBidPrice − effective_cost_per_bid) × pack_size / sqrt(bidders)
 *                   = total marginal upside in $ per √competitor
 *   non-pack score = projected_profit / sqrt(bidders)
 *
 * Packs always rank above non-packs in acquire mode (a pack refills our
 * bid pool, a non-pack only sells for cash). Within a tier, higher score
 * wins. Same scoring is used by the Waiting tab sort and the daemon's
 * focus picker, so they always agree.
 */

import type { DealDashAuction, MarketEntry, StrategyConfig } from '../types.js';
import { packSizeFromTitle, totalSpent, projectedProfit } from './profit.js';

export interface ScoreResult {
  pack: boolean;
  score: number;
  /** Total upside in $ — useful for display alongside the score */
  upside: number;
}

export function rejoinScore(
  a: DealDashAuction,
  market: MarketEntry | null | undefined,
  cfg: StrategyConfig,
  pack: boolean,
): ScoreResult {
  const competition = Math.sqrt(Math.max(1, a.bidders));
  if (pack) {
    const sz = packSizeFromTitle(a.title) || 1;
    const effPerBid = totalSpent(a, cfg) / sz;
    const upside = (cfg.storeBidPrice - effPerBid) * sz;
    return { pack: true, score: upside / competition, upside };
  }
  const upside = projectedProfit(a, market, cfg, false) ?? 0;
  return { pack: false, score: upside / competition, upside };
}

/**
 * Sort auctions by rejoin score, packs always first. Stable order for
 * the focus picker, the Waiting tab, and any other "next to defend" UI.
 */
export function compareRejoin(
  a: DealDashAuction,
  b: DealDashAuction,
  marketOf: (auction: DealDashAuction) => MarketEntry | null | undefined,
  cfg: StrategyConfig,
  packOf: (auction: DealDashAuction) => boolean,
): number {
  const sa = rejoinScore(a, marketOf(a), cfg, packOf(a));
  const sb = rejoinScore(b, marketOf(b), cfg, packOf(b));
  if (sa.pack !== sb.pack) return sa.pack ? -1 : 1;
  return sb.score - sa.score;
}
