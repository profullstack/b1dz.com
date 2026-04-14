/**
 * In-memory event channel. Used for tests and single-process dev, where
 * the observer and daemon both live in one node. Not suitable for
 * multi-worker deployments — use the Postgres channel for those.
 */

import type {
  EventChannel,
  QueuedOpportunity,
  PublishOptions,
  ClaimOptions,
  OpportunityStatus,
} from './types.js';
import type { Opportunity } from '@b1dz/venue-types';

export interface InMemoryChannelOptions {
  /** Clock injection for determinism in tests. */
  now?: () => number;
  /** UUID generator injection. Defaults to crypto.randomUUID. */
  uuid?: () => string;
  /** Default TTL for publish() when none specified. */
  defaultTtlMs?: number;
}

export class InMemoryEventChannel implements EventChannel {
  private readonly rows = new Map<string, QueuedOpportunity>();
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly defaultTtlMs: number;

  constructor(opts: InMemoryChannelOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.uuid = opts.uuid ?? (() => {
      // crypto.randomUUID lives on globalThis in Node 20+.
      const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
      return c?.randomUUID?.() ?? `mem-${Math.random().toString(36).slice(2, 12)}`;
    });
    this.defaultTtlMs = opts.defaultTtlMs ?? 5_000;
  }

  async publish(opportunity: Opportunity, opts: PublishOptions = {}): Promise<QueuedOpportunity> {
    const queueId = this.uuid();
    const createdAt = this.now();
    const row: QueuedOpportunity = {
      queueId,
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      resolvedAt: null,
      resolvedReason: null,
      createdAt,
      expiresAt: createdAt + (opts.ttlMs ?? this.defaultTtlMs),
      opportunity,
    };
    this.rows.set(queueId, row);
    return row;
  }

  async claim(opts: ClaimOptions = {}): Promise<QueuedOpportunity[]> {
    const limit = Math.max(1, opts.limit ?? 1);
    const claimer = opts.claimer ?? 'default';
    const now = this.now();

    // Walk pending rows oldest-first, skipping expired ones. Pending rows
    // past expiry become 'expired' in-place so the inspector sees them
    // correctly and nothing can grab them anymore.
    const ordered = [...this.rows.values()]
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);

    const claimed: QueuedOpportunity[] = [];
    for (const row of ordered) {
      if (row.expiresAt <= now) {
        row.status = 'expired';
        row.resolvedAt = now;
        row.resolvedReason = 'ttl';
        continue;
      }
      row.status = 'claimed';
      row.claimedBy = claimer;
      row.claimedAt = now;
      claimed.push(row);
      if (claimed.length >= limit) break;
    }
    return claimed;
  }

  async resolve(
    queueId: string,
    status: Exclude<OpportunityStatus, 'pending' | 'claimed'>,
    reason: string,
  ): Promise<void> {
    const row = this.rows.get(queueId);
    if (!row) throw new Error(`unknown queueId ${queueId}`);
    row.status = status;
    row.resolvedAt = this.now();
    row.resolvedReason = reason;
  }

  async inspect(status?: OpportunityStatus): Promise<QueuedOpportunity[]> {
    const all = [...this.rows.values()];
    if (!status) return all.sort((a, b) => a.createdAt - b.createdAt);
    return all.filter((r) => r.status === status).sort((a, b) => a.createdAt - b.createdAt);
  }
}
