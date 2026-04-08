/**
 * Storage interface — pluggable backend for opportunities, alerts, source state.
 *
 * The JSON adapter (in @b1dz/storage-json) writes to local files. A future
 * Supabase adapter will implement the same interface against Postgres tables.
 *
 * All keys are strings; "collection" is just a logical grouping.
 */

export interface Storage {
  get<T>(collection: string, key: string): Promise<T | null>;
  put<T>(collection: string, key: string, value: T): Promise<void>;
  delete(collection: string, key: string): Promise<void>;
  list<T>(collection: string): Promise<T[]>;
  /** Best-effort query helper — adapters may optimize, JSON falls back to filter */
  query<T>(collection: string, predicate: (v: T) => boolean): Promise<T[]>;
}

export const COLLECTIONS = {
  opportunities: 'opportunities',
  alerts: 'alerts',
  sourceState: 'source-state',
} as const;
