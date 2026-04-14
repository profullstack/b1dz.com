/**
 * Event-channel interface between `b1dz observe` (producer) and the v2
 * trade daemon (consumer). See PRD §11A.2.
 *
 * The boundary is explicit: observe publishes opportunities, daemon
 * claims them atomically, applies final risk checks, then marks the
 * outcome. A claim uses SELECT ... FOR UPDATE SKIP LOCKED semantics on
 * the Postgres impl so multiple daemon workers can share the queue
 * without double-processing.
 */

import type { Opportunity } from '@b1dz/venue-types';

export type OpportunityStatus =
  | 'pending'
  | 'claimed'
  | 'executing'
  | 'filled'
  | 'rejected'
  | 'failed'
  | 'expired';

export interface QueuedOpportunity {
  /** Durable queue ID (uuid). Distinct from Opportunity.id which is the
   *  semantic "this route on this venue pair" identifier. */
  queueId: string;
  status: OpportunityStatus;
  claimedBy: string | null;
  claimedAt: number | null;
  resolvedAt: number | null;
  resolvedReason: string | null;
  createdAt: number;
  expiresAt: number;
  opportunity: Opportunity;
}

export interface PublishOptions {
  /** Milliseconds until an unpicked opportunity is considered expired and
   *  skipped by future claims. Default 5000. */
  ttlMs?: number;
}

export interface ClaimOptions {
  /** Max number of opportunities to claim in one call. Default 1. */
  limit?: number;
  /** Identifier of the claiming daemon worker for audit / contention
   *  tracking. Default "default". */
  claimer?: string;
}

export interface EventChannel {
  /** Insert an opportunity into the queue in `pending` state. */
  publish(opp: Opportunity, opts?: PublishOptions): Promise<QueuedOpportunity>;

  /** Atomically claim up to N unexpired pending opportunities and mark
   *  them `claimed` by the given claimer. */
  claim(opts?: ClaimOptions): Promise<QueuedOpportunity[]>;

  /** Mark a previously-claimed opportunity with a terminal status. */
  resolve(queueId: string, status: Exclude<OpportunityStatus, 'pending' | 'claimed'>, reason: string): Promise<void>;

  /** Inspect the current queue state — primarily for observability. */
  inspect(status?: OpportunityStatus): Promise<QueuedOpportunity[]>;
}
