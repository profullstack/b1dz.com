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
import { createDecipheriv } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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

function decryptBlob(row: UserSettingsRow, key: Buffer): Record<string, string> | null {
  if (!row.payload_secret_ciphertext || !row.payload_secret_iv || !row.payload_secret_tag) return null;
  try {
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
  } catch (e) {
    console.warn(`user-config: decrypt failed for ${row.user_id.slice(0, 8)}: ${(e as Error).message}`);
    return null;
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

/** Test hook: drop all cached entries. */
export function clearUserConfigCacheForTesting(): void {
  cache.clear();
  warnedNoKey = false;
}

/**
 * Keys we apply as env overlay during a tick. Listed explicitly to avoid
 * pulling in unrelated env vars and to make the migration surface easy
 * to audit. Add more as the daemon grows.
 */
const OVERLAY_KEYS: readonly string[] = [
  // Secrets
  'COINBASE_API_KEY_NAME',
  'COINBASE_API_PRIVATE_KEY',
  'COINBASE_API_PRIVATE_KEY_B',
  'COINBASE_EC_KEY_B',
  'COINBASE_EC_KEY_B64',
  'COINBASE_API_PRIVATE_KEY_B64',
  'KRAKEN_API_KEY',
  'KRAKEN_API_SECRET',
  'BINANCE_US_API_KEY',
  'BINANCE_US_API_SECRET',
  'GEMINI_API_KEY',
  'GEMINI_API_SECRET',
  'GEMINI_NONCE_OFFSET',
  'GEMINI_ACCOUNT',
  'EVM_PRIVATE_KEY',
  'SOLANA_PRIVATE_KEY',
  'ONEINCH_API_KEY',
  // Plain user-overridable — risk
  'DAILY_LOSS_LIMIT_PCT',
  'DEX_SLIPPAGE_BPS',
  'DEX_TRADE_BUDGET_USD',
  'DEX_TRADE_MAX_USD',
  'DEX_TRADE_EXECUTION',
  'MARGIN_TRADING',
  'BUY_SLIPPAGE_BPS',
  'HARD_STOP_PCT',
  'TAKE_PROFIT_PCT',
  'MIN_NET_PROFIT_PCT',
  'ENTRY_MIN_SCORE',
  'MIN_HOLD_SECS',
  'MIN_VOLUME_USD',
  'MIN_PER_EXCHANGE_VOL_USD',
  'ROTATE_ADVERSE_PCT',
  'ROTATE_MIN_HOLD_MS',
  // Strategy modes
  'ARB_MODE',
  'V2_MODE',
  // CEX arb sizing
  'ARB_MAX_TRADE_USD',
  'ARB_SIZE_USD',
  'ARB_MIN_NET_USD',
  'ARB_MIN_NET_BPS',
  'ARB_EXECUTOR_UNISWAP_BASE',
  // DCA
  'DCA_ENABLED',
  'DCA_TOTAL_ALLOCATION_PCT',
  'DCA_MAX_COINS',
  'DCA_COINS',
  'DCA_EXCHANGES',
  'DCA_INTERVAL_MS',
  // V2 pipeline
  'V2_SIZE_USD',
  'V2_MAX_PAIRS',
  'V2_MIN_NET_USD',
  'V2_MIN_NET_BPS',
  'V2_MAX_TRADE_USD',
  // 0x API
  'ZEROX_API_KEY',
  // Master switches
  'TRADING_ENABLED',
  'PUMPFUN_ENABLE_SCRAPE',
  // Pump.fun live trading
  'PUMPFUN_TRADE_EXECUTION',
  'PUMPFUN_TRADE_SOL',
] as const;

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
      const v = config.getSecret(k);
      if (v !== undefined && v !== '') process.env[k] = v;
      // If the user's config has nothing for k, leave the original env value alone.
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
