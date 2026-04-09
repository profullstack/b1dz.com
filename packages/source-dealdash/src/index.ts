/**
 * @b1dz/source-dealdash
 *
 * Phase 3f status: strategy + polling + orchestrator + decision engine +
 * daemon worker projection all lifted. The vendored TUI is now DUPLICATED
 * — the daemon runs the same decisions via a different code path. Next
 * phase deletes the TUI copy.
 */

import type { Source } from '@b1dz/core';
export * from './types.js';
export * from './strategy/index.js';
export * from './api/index.js';
export * from './poll.js';
export * from './project.js';

import type { DealDashAuction } from './types.js';

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
