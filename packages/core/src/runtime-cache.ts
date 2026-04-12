import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_RUNTIME_CACHE_DIR = process.env.B1DZ_RUNTIME_CACHE_DIR || '/tmp/b1dz-runtime-cache';
const SOURCE_STATE_TTL_MS = 2 * 60_000;
const LIVE_SOURCE_STATE_FIELDS = new Set([
  'activityLog',
  'binanceBalance',
  'coinbaseBalance',
  'daemon',
  'openOrders',
  'opportunities',
  'prices',
  'rawLog',
  'recentTrades',
  'signals',
  'spreads',
  'tradeState',
  'tradeStatus',
  'krakenBalance',
]);

interface CacheEnvelope<T> {
  expiresAt: number;
  value: T;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function sourceStateDir(userId: string): string {
  return resolve(DEFAULT_RUNTIME_CACHE_DIR, 'source-state', enc(userId));
}

function sourceStatePath(userId: string, sourceId: string): string {
  return resolve(sourceStateDir(userId), `${enc(sourceId)}.json`);
}

async function readEnvelope<T>(path: string): Promise<CacheEnvelope<T> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed.expiresAt !== 'number') return null;
    if (parsed.expiresAt <= Date.now()) {
      await rm(path, { force: true }).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeEnvelope<T>(path: string, value: T, ttlMs: number) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const envelope: CacheEnvelope<T> = { expiresAt: Date.now() + ttlMs, value };
  await writeFile(tmp, JSON.stringify(envelope), 'utf8');
  await rename(tmp, path);
}

export function stripLiveSourceState<T>(value: T | null): T | null {
  if (!value || typeof value !== 'object') return value;
  const next = { ...(value as Record<string, unknown>) };
  for (const key of LIVE_SOURCE_STATE_FIELDS) delete next[key];
  return next as T;
}

export async function getRuntimeSourceState<T>(userId: string, sourceId: string): Promise<T | null> {
  const entry = await readEnvelope<T>(sourceStatePath(userId, sourceId));
  return entry?.value ?? null;
}

export async function setRuntimeSourceState<T>(userId: string, sourceId: string, value: T, ttlMs = SOURCE_STATE_TTL_MS) {
  await writeEnvelope(sourceStatePath(userId, sourceId), value, ttlMs);
}

export async function deleteRuntimeSourceState(userId: string, sourceId: string) {
  await rm(sourceStatePath(userId, sourceId), { force: true }).catch(() => {});
}

export async function listRuntimeSourceStates<T>(userId: string): Promise<Array<{ sourceId: string; value: T }>> {
  const dir = sourceStateDir(userId);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const items = await Promise.all(names
    .filter((name) => name.endsWith('.json'))
    .map(async (name) => {
      const entry = await readEnvelope<T>(resolve(dir, name));
      if (!entry) return null;
      return {
        sourceId: decodeURIComponent(name.slice(0, -5)),
        value: entry.value,
      };
    }));

  return items.filter((item): item is { sourceId: string; value: T } => item != null);
}
