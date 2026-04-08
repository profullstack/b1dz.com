/**
 * Supabase storage adapter — drop-in replacement for @b1dz/storage-json.
 *
 * Maps the @b1dz/core Storage interface onto Postgres tables managed by
 * Supabase. Each "collection" is a table; the key is a primary-key column.
 *
 * Tables (see supabase/migrations/0001_init.sql):
 *   - opportunities (id pk, source_id, payload jsonb, updated_at)
 *   - alerts        (id pk, source_id, level, payload jsonb, at)
 *   - source_state  (source_id pk, payload jsonb, updated_at)
 *
 * The full record always lives in `payload` so the storage layer doesn't
 * need to know the schema of every value type. Indexed/queryable fields
 * (source_id, level, updated_at) are denormalized into top-level columns.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Storage } from '@b1dz/core';
import { COLLECTIONS } from '@b1dz/core';

interface Row { id: string; user_id?: string; source_id?: string; level?: string; payload: unknown; updated_at?: string; at?: string; }

const TABLE_FOR: Record<string, { table: string; pk: string }> = {
  [COLLECTIONS.opportunities]: { table: 'opportunities', pk: 'id' },
  [COLLECTIONS.alerts]: { table: 'alerts', pk: 'id' },
  [COLLECTIONS.sourceState]: { table: 'source_state', pk: 'source_id' },
};

export class SupabaseStorage implements Storage {
  private client: SupabaseClient;
  private userId: string | null;

  constructor(opts: { url: string; key: string; userId?: string | null; client?: SupabaseClient }) {
    this.client = opts.client ?? createClient(opts.url, opts.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.userId = opts.userId ?? null;
  }

  private resolve(collection: string) {
    const t = TABLE_FOR[collection];
    if (!t) throw new Error(`unknown collection: ${collection}`);
    return t;
  }

  async get<T>(collection: string, key: string): Promise<T | null> {
    const { table, pk } = this.resolve(collection);
    let q = this.client.from(table).select('payload').eq(pk, key);
    if (this.userId) q = q.eq('user_id', this.userId);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return (data?.payload as T) ?? null;
  }

  async put<T>(collection: string, key: string, value: T): Promise<void> {
    const { table, pk } = this.resolve(collection);
    const v = value as Record<string, unknown>;
    const row: Row = {
      id: key,
      payload: value,
      user_id: this.userId ?? undefined,
      source_id: typeof v.sourceId === 'string' ? v.sourceId : undefined,
      level: typeof v.level === 'string' ? v.level : undefined,
      updated_at: new Date().toISOString(),
    };
    if (collection === COLLECTIONS.alerts && typeof v.at === 'number') {
      row.at = new Date(v.at).toISOString();
    }
    if (pk === 'source_id') {
      row.source_id = key;
    }
    // For source_state we conflict on (user_id, source_id) so each user gets
    // their own row per source.
    const conflict = collection === COLLECTIONS.sourceState ? 'user_id,source_id' : pk;
    const { error } = await this.client.from(table).upsert(row, { onConflict: conflict });
    if (error) throw error;
  }

  async delete(collection: string, key: string): Promise<void> {
    const { table, pk } = this.resolve(collection);
    let q = this.client.from(table).delete().eq(pk, key);
    if (this.userId) q = q.eq('user_id', this.userId);
    const { error } = await q;
    if (error) throw error;
  }

  async list<T>(collection: string): Promise<T[]> {
    const { table } = this.resolve(collection);
    let q = this.client.from(table).select('payload');
    if (this.userId) q = q.eq('user_id', this.userId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map((r) => r.payload as T);
  }

  async query<T>(collection: string, predicate: (v: T) => boolean): Promise<T[]> {
    // Generic predicate runs in JS — for source_id / level / time-range
    // queries, callers should use Supabase directly via getClient().
    return (await this.list<T>(collection)).filter(predicate);
  }

  /** Escape hatch for source-specific queries that benefit from SQL. */
  getClient(): SupabaseClient {
    return this.client;
  }
}
