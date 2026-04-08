/**
 * The daemon-side interface every source implements.
 *
 * `Source<T>` from @b1dz/core describes the abstract polling contract.
 * `SourceWorker` adds the things the daemon's scheduler needs:
 *   - id              stable name used for logging + source_state.source_id
 *   - pollIntervalMs  scheduler cadence
 *   - hasCredentials  given a source_state row, does this user have what
 *                     this source needs to actually run?
 *   - tick            do one cycle of work for one user
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface UserContext {
  /** Supabase service-role client (RLS bypassed) */
  supabase: SupabaseClient;
  userId: string;
  /** Current source_state.payload for this (user, source) row */
  payload: Record<string, unknown>;
  /** Persist a partial update of payload — merges and upserts */
  savePayload: (next: Record<string, unknown>) => Promise<void>;
}

export interface SourceWorker {
  id: string;
  pollIntervalMs: number;
  hasCredentials: (payload: Record<string, unknown>) => boolean;
  tick: (ctx: UserContext) => Promise<void>;
}
