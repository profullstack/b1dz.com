/**
 * DealDash state synchronization with Supabase.
 *
 * Replaces the local JSON cache files (.title-cache.json, .bids-spent.json,
 * .market-prices.json, etc.) with a single per-user blob in
 * `source_state.payload.caches`. Same shape: an object of named cache slots,
 * each holding either a flat key→value map or a list.
 *
 * Architecture:
 *   - api.ts and dealdash.tsx hold the in-memory Maps/Records (unchanged)
 *   - At module load, each file `registerCache(name, hydrate, serialize)`
 *     to plug its Map into the registry
 *   - On startup, the entry point calls `hydrateAll(userId)` once — that
 *     fetches the row from Supabase and replays each slot into its Map
 *   - A periodic timer (and process exit hook) calls `flushAll(userId)` to
 *     serialize every Map back into the row
 *
 * No more file IO. Per-user, per-source. Same source_state row that holds
 * the DealDash credentials.
 */

import { getApiClient } from '../auth.js';

interface CacheSlot {
  name: string;
  hydrate: (data: unknown) => void;
  serialize: () => unknown;
}

const registry: CacheSlot[] = [];

export function registerCache(name: string, hydrate: (data: unknown) => void, serialize: () => unknown): void {
  registry.push({ name, hydrate, serialize });
}

// Use the singleton from auth.ts so token refreshes are shared and persisted.
const makeApiClient = getApiClient;

let lastFetchedPayload: Record<string, unknown> = {};

/** Fetch source_state.payload via the b1dz API and replay every registered slot. */
export async function hydrateAll(_userId: string, sourceId = 'dealdash'): Promise<void> {
  try {
    const api = makeApiClient();
    const payload = (await api.get<Record<string, unknown>>('source-state', sourceId)) ?? {};
    lastFetchedPayload = payload;
    const caches = (payload.caches as Record<string, unknown>) ?? {};
    let hydrated = 0;
    for (const slot of registry) {
      if (slot.name in caches) {
        try { slot.hydrate(caches[slot.name]); hydrated++; } catch (e) { console.error(`hydrate ${slot.name}: ${(e as Error).message}`); }
      }
    }
    console.log(`state-sync: hydrated ${hydrated}/${registry.length} caches via b1dz API`);
  } catch (e) {
    console.error(`state-sync hydrate failed: ${(e as Error).message}`);
  }
}

/** Serialize every registered slot and upsert via the b1dz API. */
export async function flushAll(_userId: string, sourceId = 'dealdash'): Promise<void> {
  if (!registry.length) return;
  const caches: Record<string, unknown> = {};
  for (const slot of registry) {
    try { caches[slot.name] = slot.serialize(); } catch (e) { console.error(`serialize ${slot.name}: ${(e as Error).message}`); }
  }
  try {
    const api = makeApiClient();
    // Stamp sourceId so the storage layer can route the row correctly.
    // The PUT route also reads this to set source_state.source_id.
    const payload = { ...lastFetchedPayload, caches, sourceId };
    await api.put('source-state', sourceId, payload);
    lastFetchedPayload = payload;
  } catch (e) {
    console.error(`state-sync flush failed: ${(e as Error).message}`);
  }
}

let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushDirty = false;
export function markDirty(): void { flushDirty = true; }

/** Start a debounced background flush — runs every `intervalMs` if marked dirty,
 *  AND on graceful exit (best effort). Idempotent. */
export function startBackgroundFlush(userId: string, sourceId = 'dealdash', intervalMs = 30_000): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (!flushDirty) return;
    flushDirty = false;
    void flushAll(userId, sourceId);
  }, intervalMs);
  const exitHandler = () => { void flushAll(userId, sourceId); };
  process.on('beforeExit', exitHandler);
  process.on('SIGINT', () => { exitHandler(); process.exit(0); });
  process.on('SIGTERM', () => { exitHandler(); process.exit(0); });
}

/** Stop the background timer so the event loop can exit cleanly. */
export function stopBackgroundFlush(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

// ----- helpers for registering common Map/Record shapes -----

export function registerMap<V>(name: string, map: Map<number, V>): void {
  registerCache(
    name,
    (data) => {
      if (!data || typeof data !== 'object') return;
      for (const [k, v] of Object.entries(data as Record<string, V>)) map.set(Number(k), v);
    },
    () => {
      const obj: Record<string, V> = {};
      for (const [k, v] of map) obj[k] = v;
      return obj;
    },
  );
}

export function registerRecord<V>(name: string, record: Record<string, V>): void {
  registerCache(
    name,
    (data) => {
      if (!data || typeof data !== 'object') return;
      for (const [k, v] of Object.entries(data as Record<string, V>)) record[k] = v;
    },
    () => ({ ...record }),
  );
}

export function registerObject<T>(name: string, get: () => T, set: (v: T) => void): void {
  registerCache(name, (data) => set(data as T), () => get());
}
