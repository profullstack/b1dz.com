/**
 * Common domain types shared across all sources (auctions, travel, crypto, …).
 *
 * The whole system runs on three primitives:
 *   - Source:       a thing that polls an external system for items
 *   - Opportunity:  a normalized scored opportunity derived from one item
 *   - Alert:        a user-facing event (won, lost, error, threshold hit)
 *
 * Anything domain-specific lives in `metadata`.
 */

export type SourceId = string; // 'dealdash' | 'ebay' | 'binance' | …

export interface Opportunity {
  /** Unique key: `${sourceId}:${externalId}` */
  id: string;
  sourceId: SourceId;
  externalId: string;
  title: string;
  category?: string;
  /** What it costs us right now (bids spent + price, ticker price, ticket cost…) */
  costNow: number;
  /** Expected sell/exchange/realized value */
  projectedReturn: number;
  /** projectedReturn − costNow (precomputed for convenience) */
  projectedProfit: number;
  /** 0..1 confidence in the projection (data quality, sample size, etc.) */
  confidence: number;
  /** Optional deadline; null = ongoing */
  expiresAt?: number;
  /** Free-form bag — the source-specific original record lives here */
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type AlertLevel = 'good' | 'warn' | 'bad' | 'info';

export interface Alert {
  id: string;
  at: number;
  level: AlertLevel;
  sourceId: SourceId;
  text: string;
  link?: string;
  /** Reference back to an opportunity if applicable */
  opportunityId?: string;
}

/** Per-source persistent state (cursors, cached caches, mode flags). */
export interface SourceState {
  sourceId: SourceId;
  lastPolledAt?: number;
  data: Record<string, unknown>;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  permanent?: boolean; // true = don't retry
}
