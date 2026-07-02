/**
 * Per-user config loader for the daemon.
 *
 * Loads the user_settings row, decrypts the AES-256-GCM secret blob with
 * SETTINGS_ENCRYPTION_KEY, and exposes a unified getter with this
 * lookup precedence:
 *
 *   1. user_settings.payload_secret[KEY]   (decrypted)
 *   2. user_settings.payload_plain[KEY]
 *   3. process.env[KEY]
 *   4. fallback arg passed to the getter
 *
 * The secret-blob algorithm matches apps/web/src/lib/secret-crypto.ts:
 * AES-256-GCM, base64-encoded ciphertext + 12-byte iv + 16-byte auth tag.
 *
 * Caches per-user for CACHE_TTL_MS. Callers that just wrote settings
 * should call refreshUserConfig(userId) to invalidate.
 *
 * If SETTINGS_ENCRYPTION_KEY is missing the loader logs a one-shot
 * warning and degrades to env-only — the daemon must keep running for
 * users who have no user_settings row.
 *
 * Concurrency note: applyEnvOverlay() temporarily mutates process.env
 * for the duration of the callback so existing adapter code that reads
 * process.env.X transparently picks up user-specific values without
 * threading UserConfig through every adapter constructor. Concurrent
 * calls are serialized via an async mutex (envOverlayMutex) — this
 * means concurrent ticks for different users queue at the overlay
 * boundary. For the current single-active-user deployment this is
 * fine; for high-concurrency multi-user deployments the right fix is
 * to thread UserConfig through every adapter.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ALL_OVERLAY_KEYS, SECRET_SET } from '@b1dz/core';

const ALGORITHM = 'aes-256-gcm';
const CACHE_TTL_MS = 60_000;

interface UserSettingsRow {
  user_id: string;
  payload_plain: Record<string, unknown> | null;
  payload_secret_ciphertext: string | null;
  payload_secret_iv: string | null;
  payload_secret_tag: string | null;
  updated_at: string | null;
}

export interface UserConfig {
  readonly userId: string;
  /** Lookup with precedence: secret blob → plain blob → process.env → fallback. */
  getSecret(key: string, fallback?: string): string | undefined;
  /** Lookup with precedence: plain blob → process.env → fallback. (Skips secret blob.) */
  getPlain(key: string, fallback?: string): string | undefined;
  /** STRICT: this user's secret blob ONLY — no plain, no env. Use for per-user
   *  credentials so they never fall back to the operator's env keys. */
  getUserSecret(key: string): string | undefined;
  /** STRICT: this user's plain blob ONLY — no env. Use for per-user identifiers
   *  (account ids, gateway URLs) that must not fall back to operator env. */
  getUserPlain(key: string): string | undefined;
  /** Convenience: parse the resolved string as a number. Returns fallback if missing or not finite. */
  getNumber(key: string, fallback?: number): number | undefined;
  /** Convenience: parse the resolved string as a boolean ("true"/"1"/"yes"/"on"). */
  getBool(key: string, fallback?: boolean): boolean | undefined;
}

interface CacheEntry {
  expiresAt: number;
  value: UserConfig;
}

const cache = new Map<string, CacheEntry>();
let warnedNoKey = false;

let lazyClient: SupabaseClient | null = null;
function defaultClient(): SupabaseClient {
  if (lazyClient) return lazyClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('user-config: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY missing');
  }
  lazyClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return lazyClient;
}

/** For tests: inject an in-memory Supabase-like fixture. */
export function setSupabaseClientForTesting(c: SupabaseClient | null): void {
  lazyClient = c;
}

function loadEncryptionKey(): Buffer | null {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.warn('user-config: SETTINGS_ENCRYPTION_KEY missing — secrets cannot be decrypted, falling back to process.env only');
    }
    return null;
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.warn(`user-config: SETTINGS_ENCRYPTION_KEY decodes to ${buf.length} bytes (need 32) — secrets cannot be decrypted`);
    }
    return null;
  }
  return buf;
}

function deriveUserKey(masterKey: Buffer, userId: string): Buffer {
  return createHmac('sha256', masterKey).update(userId).digest();
}

function decryptBlobWithKey(row: UserSettingsRow, key: Buffer): Record<string, string> | null {
  if (!row.payload_secret_ciphertext || !row.payload_secret_iv || !row.payload_secret_tag) return null;
  const iv = Buffer.from(row.payload_secret_iv, 'base64');
  const tag = Buffer.from(row.payload_secret_tag, 'base64');
  const ct = Buffer.from(row.payload_secret_ciphertext, 'base64');
  const dec = createDecipheriv(ALGORITHM, key, iv);
  dec.setAuthTag(tag);
  const out = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  const parsed = JSON.parse(out) as unknown;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') result[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') result[k] = String(v);
    }
    return result;
  }
  return null;
}

function decryptBlob(row: UserSettingsRow, key: Buffer): Record<string, string> | null {
  try {
    return decryptBlobWithKey(row, deriveUserKey(key, row.user_id));
  } catch (e) {
    try {
      return decryptBlobWithKey(row, key);
    } catch {
      console.warn(`user-config: decrypt failed for ${row.user_id.slice(0, 8)}: ${(e as Error).message}`);
      return null;
    }
  }
}

function plainAsString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function buildConfig(userId: string, secret: Record<string, string> | null, plain: Record<string, unknown> | null): UserConfig {
  const secretMap = secret ?? {};
  const plainMap = plain ?? {};
  const getPlain = (key: string, fallback?: string): string | undefined => {
    const p = plainAsString(plainMap[key]);
    if (p !== undefined && p !== '') return p;
    const env = process.env[key];
    if (env !== undefined && env !== '') return env;
    return fallback;
  };
  const getSecret = (key: string, fallback?: string): string | undefined => {
    const s = secretMap[key];
    if (s !== undefined && s !== '') return s;
    return getPlain(key, fallback);
  };
  // STRICT per-user getters: read ONLY this user's encrypted/plain blob — never
  // process.env. Use these for per-user credentials in a multi-tenant context so
  // one user's missing keys can't fall back to the operator's env keys (which
  // would let them act on the operator's broker/exchange accounts).
  const getUserSecret = (key: string): string | undefined => {
    const s = secretMap[key];
    return s !== undefined && s !== '' ? s : undefined;
  };
  const getUserPlain = (key: string): string | undefined => {
    const p = plainAsString(plainMap[key]);
    return p !== undefined && p !== '' ? p : undefined;
  };
  const getNumber = (key: string, fallback?: number): number | undefined => {
    const raw = getSecret(key);
    if (raw === undefined) return fallback;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const getBool = (key: string, fallback?: boolean): boolean | undefined => {
    const raw = getSecret(key);
    if (raw === undefined) return fallback;
    const lower = raw.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lower)) return true;
    if (['false', '0', 'no', 'off'].includes(lower)) return false;
    return fallback;
  };
  return Object.freeze({
    userId,
    getSecret,
    getPlain,
    getUserSecret,
    getUserPlain,
    getNumber,
    getBool,
  });
}

async function fetchRow(userId: string): Promise<UserSettingsRow | null> {
  const client = defaultClient();
  const { data, error } = await client
    .from('user_settings')
    .select('user_id, payload_plain, payload_secret_ciphertext, payload_secret_iv, payload_secret_tag, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn(`user-config: fetch failed for ${userId.slice(0, 8)}: ${error.message}`);
    return null;
  }
  return (data as UserSettingsRow | null) ?? null;
}

/**
 * Load (and cache) the per-user config provider.
 * Cache TTL: 60s. Call refreshUserConfig(userId) after a settings write
 * to invalidate.
 */
export async function loadUserConfig(userId: string): Promise<UserConfig> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit.value;

  let row: UserSettingsRow | null = null;
  try {
    row = await fetchRow(userId);
  } catch (e) {
    console.warn(`user-config: load failed for ${userId.slice(0, 8)}: ${(e as Error).message}`);
  }

  let secretBlob: Record<string, string> | null = null;
  if (row) {
    const key = loadEncryptionKey();
    if (key) secretBlob = decryptBlob(row, key);
  }

  const config = buildConfig(userId, secretBlob, row?.payload_plain ?? null);
  cache.set(userId, { value: config, expiresAt: now + CACHE_TTL_MS });

  // One-shot per-user load log so prod can verify user_settings is the
  // source of truth (vs env fallback). Cache TTL means this prints
  // ~once per minute per user, which is quiet enough.
  const secretCount = secretBlob ? Object.keys(secretBlob).length : 0;
  const plainCount = row?.payload_plain ? Object.keys(row.payload_plain as Record<string, unknown>).length : 0;
  console.log(`user-config: loaded ${userId.slice(0, 8)}… secrets=${secretCount} plain=${plainCount} ${row ? 'from db' : '(no row, env-only)'}`);

  return config;
}

/** Drop the cached config for a user — next loadUserConfig will refetch. */
export function refreshUserConfig(userId: string): void {
  cache.delete(userId);
}

/**
 * Merge `patch` into the user's encrypted secret blob and persist it
 * (decrypt → assign → re-encrypt → upsert), then invalidate the cache. Used by
 * the daemon's OAuth token auto-refresh to write the fresh access token back.
 * No-op (throws) if SETTINGS_ENCRYPTION_KEY is missing.
 */
export async function mergeUserSecret(userId: string, patch: Record<string, string>): Promise<void> {
  const key = loadEncryptionKey();
  if (!key) throw new Error('mergeUserSecret: SETTINGS_ENCRYPTION_KEY unavailable');
  const row = await fetchRow(userId);
  const existing = row ? decryptBlob(row, key) ?? {} : {};
  const merged: Record<string, string> = { ...existing, ...patch };

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveUserKey(key, userId), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(merged), 'utf8'), cipher.final()]);
  const client = defaultClient();
  const { error } = await client.from('user_settings').upsert(
    {
      user_id: userId,
      payload_secret_ciphertext: ct.toString('base64'),
      payload_secret_iv: iv.toString('base64'),
      payload_secret_tag: cipher.getAuthTag().toString('base64'),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(error.message);
  refreshUserConfig(userId);
}

/** Test hook: drop all cached entries. */
export function clearUserConfigCacheForTesting(): void {
  cache.clear();
  warnedNoKey = false;
}

/**
 * Keys we apply as env overlay during a tick.
 *
 * Derived from the shared `@b1dz/core` settings catalog so this list
 * stays in lockstep with what the web UI actually saves. Previously
 * this was a hand-maintained list and drifted: BASE_RPC_URL,
 * SOLANA_RPC_URL, ARB_TRIANGULAR_*, ARB_AUTO_SEED_*, ARB_LIQ_*,
 * EVM_WALLET_ADDRESS, SOLANA_WALLET_ADDRESS, REQUIRE_CONFIRM_UPTREND,
 * proxy creds and several other knobs were silently dropped. The
 * resulting symptom in production: only Gemini executed trades because
 * every DEX/Jupiter/Pump.fun adapter fell through to "missing env" and
 * the v2/triangular engines never armed.
 *
 * `ALL_OVERLAY_KEYS` is the union of SECRET_FIELDS + PLAIN_STRING_FIELDS
 * + PLAIN_NUMBER_FIELDS + PLAIN_BOOL_FIELDS — adding a new user-facing
 * setting in the catalog is automatically picked up here.
 *
 * The handful of keys below are EXTRA — they're not user-saveable from
 * the UI yet but are honored from process.env at runtime, so we want
 * the per-tick overlay to NOT shadow them with a stale snapshot. They
 * are listed explicitly so the audit surface stays clear.
 */
const EXTRA_OVERLAY_KEYS: readonly string[] = [
  // Coinbase: legacy *_B64 envs (some operators have them in env files
  // even though the UI uses the non-_B64 names).
  'COINBASE_EC_KEY_B64',
  'COINBASE_API_PRIVATE_KEY_B64',
  // Aggregator API keys not in the UI catalog yet.
  'ZEROX_API_KEY',
  // Pump.fun trade size knob (UI exposes the toggle but not the size).
  'PUMPFUN_TRADE_SOL',
];

const OVERLAY_KEYS: readonly string[] = [
  ...new Set([...ALL_OVERLAY_KEYS, ...EXTRA_OVERLAY_KEYS]),
];

/** Credential keys that must NEVER fall back to the operator's process.env for a
 *  user who hasn't set their own — SECRET_FIELDS plus the secret extras. (The
 *  non-credential extras like PUMPFUN_TRADE_SOL are operator-level config and
 *  keep their env default.) */
const CREDENTIAL_OVERLAY_KEYS = new Set<string>([
  ...SECRET_SET,
  'COINBASE_EC_KEY_B64',
  'COINBASE_API_PRIVATE_KEY_B64',
  'ZEROX_API_KEY',
]);

/** Exposed for tests — verifies the overlay covers every user-settable
 *  catalog key plus the extras. The list itself is stable across
 *  daemon lifetimes; tests guard against silent drift. */
export function __getOverlayKeysForTesting(): readonly string[] {
  return OVERLAY_KEYS;
}

let envOverlayMutex: Promise<void> = Promise.resolve();

/**
 * Run `fn` with the user's settings temporarily overlaid on process.env.
 * Adapter code that reads `process.env.X` directly will see the user's
 * value (with secret > plain > existing-env precedence). Original env
 * is restored after `fn` resolves or rejects.
 *
 * Concurrent overlay calls are serialized — concurrent ticks for
 * different users will queue here. See module header for context.
 */
export async function applyEnvOverlay<T>(config: UserConfig, fn: () => Promise<T>): Promise<T> {
  const prev = envOverlayMutex;
  let release!: () => void;
  envOverlayMutex = new Promise<void>((r) => { release = r; });
  await prev;

  // Snapshot original values so we can restore exactly.
  const originals: Record<string, string | undefined> = {};
  for (const k of OVERLAY_KEYS) originals[k] = process.env[k];

  try {
    for (const k of OVERLAY_KEYS) {
      const isCredential = CREDENTIAL_OVERLAY_KEYS.has(k);
      // Credentials: this user's secret blob ONLY. Non-credentials (RPC URLs,
      // thresholds): the user's plain value, else keep the operator default.
      const v = isCredential ? config.getUserSecret(k) : config.getUserPlain(k);
      if (v !== undefined && v !== '') {
        process.env[k] = v;
      } else if (isCredential) {
        // No per-user credential → strip the operator's env value so it can't
        // leak into this user's tick (they'd otherwise act on the operator's
        // exchange/broker/wallet). Non-credentials keep the operator default.
        delete process.env[k];
      }
    }
    return await fn();
  } finally {
    for (const k of OVERLAY_KEYS) {
      const orig = originals[k];
      if (orig === undefined) delete process.env[k];
      else process.env[k] = orig;
    }
    release();
  }
}
