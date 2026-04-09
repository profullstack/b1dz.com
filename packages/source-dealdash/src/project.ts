/**
 * Projection helpers — turn raw API responses (AuctionDetail + AuctionInfo
 * from gonzales.php) into the normalized DealDashAuction the strategy
 * module consumes. Kept pure so daemon + TUI + tests share one
 * implementation.
 */

import type { DealDashAuction } from './types.js';
import type { AuctionDetail, AuctionInfo } from './api/auctions.js';
import { getBidders, historyContainsUser } from './api/auctions.js';

export interface ProjectInputs {
  details: AuctionDetail[];
  info: Map<number, AuctionInfo>;
  titles: Record<number, string>;
  bidsSpent: Record<number, number>;
  /** Our DealDash username — used to decide othersBidding */
  username: string;
}

export function toDisplayAuctions(inputs: ProjectInputs): DealDashAuction[] {
  const { details, info, titles, bidsSpent, username } = inputs;
  const byId = new Map<number, AuctionDetail>();
  for (const d of details) byId.set(d.auctionId, d);

  const out: DealDashAuction[] = [];
  for (const [id, ai] of info) {
    const det = byId.get(id);
    // Distinct bidders from visible history; if the history is empty
    // (auction just started, 1 bid in), fall back to "1 if anyone has
    // bid, else 0". `me` from gonzales adds us to the count if we're in.
    const histBidders = det ? getBidders(det.history) : 0;
    const iAmInHistory = det ? historyContainsUser(det.history, username) : false;
    // Total bidders = distinct users in history; if we're actively in it
    // but not yet in the visible history, add 1. Cap at max(histBidders,1)
    // when the auction has at least one recent bid.
    const totalBidders = Math.max(
      histBidders,
      ai.me > 0 ? (iAmInHistory ? histBidders : histBidders + 1) : histBidders,
      ai.x > 0 ? 1 : 0,
    );
    const othersBidding = Math.max(0, totalBidders - (ai.me > 0 || iAmInHistory ? 1 : 0));

    out.push({
      id,
      title: titles[id] ?? '',
      bidders: totalBidders,
      othersBidding,
      ddPrice: Number(ai.r ?? 0),
      bidsBooked: ai.bb?.c ?? 0,
      bidsSpent: bidsSpent[id] ?? 0,
      totalBids: ai.x,
    });
  }
  return out;
}
