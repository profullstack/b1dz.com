/**
 * DealDash source — placeholder.
 *
 * Migration plan: lift functions from ~/src/dealdash/dealdash.ts and the
 * tick() loop from ~/src/dealdash/dealdash-ink.tsx into this package.
 *
 *   - poll()      → fetch live auctions + my auctions + history + wins
 *   - evaluate()  → compute Opportunity from each auction (existing profit math)
 *   - act()       → bookBid / cancelBidBuddy / exchangeWinForBids
 *
 * The TUI in apps/cli will then become a thin renderer over the same
 * Source<DealDashAuction> instance, so behavior stays identical.
 */

import type { Source } from '@b1dz/core';

export interface DealDashAuction {
  id: number;
  title: string;
  bidders: number;
  ddPrice: number;
  bidsBooked: number;
  bidsSpent: number;
  totalBids: number;
}

export const dealDashSource: Source<DealDashAuction> = {
  id: 'dealdash',
  pollIntervalMs: 5000,
  async poll() {
    // TODO: lift from ~/src/dealdash/dealdash.ts
    return [];
  },
  evaluate(item) {
    // TODO: lift profitability/getResaleValue from dealdash-ink.tsx
    return {
      id: `dealdash:${item.id}`,
      sourceId: 'dealdash',
      externalId: String(item.id),
      title: item.title,
      costNow: 0,
      projectedReturn: 0,
      projectedProfit: 0,
      confidence: 0.5,
      metadata: { raw: item },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  },
};
