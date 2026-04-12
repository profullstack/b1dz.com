import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from 'redis';

const DEFAULT_RUNTIME_CACHE_DIR = process.env.B1DZ_RUNTIME_CACHE_DIR || '/tmp/b1dz-runtime-cache';
const REDIS_URL = process.env.REDIS_URL?.trim() || '';
const REDIS_PREFIX = process.env.B1DZ_RUNTIME_CACHE_PREFIX || 'b1dz:runtime-cache';
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

type RuntimeRedisClient = ReturnType<typeof createClient>;

let redisClientPromise: Promise<RuntimeRedisClient | null> | null = null;
let redisDisabled = false;

function enc(value: string): string {
  return encodeURIComponent(value);
}

function sourceStateRedisKey(userId: string, sourceId: string): string {
  return `${REDIS_PREFIX}:source-state:${enc(userId)}:${enc(sourceId)}`;
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

async function getRedisClient(): Promise<RuntimeRedisClient | null> {
  if (!REDIS_URL || redisDisabled) return null;
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      try {
        const client = createClient({ url: REDIS_URL });
        client.on('error', () => {});
        await client.connect();
        return client;
      } catch {
        redisDisabled = true;
        return null;
      }
    })();
  }
  return redisClientPromise;
}

export function stripLiveSourceState<T>(value: T | null): T | null {
  if (!value || typeof value !== 'object') return value;
  const next = { ...(value as Record<string, unknown>) };
  for (const key of LIVE_SOURCE_STATE_FIELDS) delete next[key];
  return next as T;
}

export async function getRuntimeSourceState<T>(userId: string, sourceId: string): Promise<T | null> {
  const redis = await getRedisClient();
  if (redis) {
    try {
      const raw = await redis.get(sourceStateRedisKey(userId, sourceId));
      return raw ? JSON.parse(raw) as T : null;
    } catch {}
  }
  const entry = await readEnvelope<T>(sourceStatePath(userId, sourceId));
  return entry?.value ?? null;
}

export async function setRuntimeSourceState<T>(userId: string, sourceId: string, value: T, ttlMs = SOURCE_STATE_TTL_MS) {
  const redis = await getRedisClient();
  if (redis) {
    try {
      await redis.set(sourceStateRedisKey(userId, sourceId), JSON.stringify(value), { PX: ttlMs });
      return;
    } catch {}
  }
  await writeEnvelope(sourceStatePath(userId, sourceId), value, ttlMs);
}

export async function deleteRuntimeSourceState(userId: string, sourceId: string) {
  const redis = await getRedisClient();
  if (redis) {
    try {
      await redis.del(sourceStateRedisKey(userId, sourceId));
      return;
    } catch {}
  }
  await rm(sourceStatePath(userId, sourceId), { force: true }).catch(() => {});
}

export async function listRuntimeSourceStates<T>(userId: string): Promise<Array<{ sourceId: string; value: T }>> {
  const redis = await getRedisClient();
  if (redis) {
    try {
      const prefix = `${REDIS_PREFIX}:source-state:${enc(userId)}:`;
      const keys = await redis.keys(`${prefix}*`);
      const items: Array<{ sourceId: string; value: T }> = [];
      for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const sourceId = decodeURIComponent(key.slice(prefix.length));
        items.push({ sourceId, value: JSON.parse(raw) as T });
      }
      return items;
    } catch {}
  }

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
