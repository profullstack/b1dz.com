/**
 * Per-user config loader for the daemon.
 *
 * Secrets are sealed under a key only the user holds (seal_version 2, see
 * @b1dz/core/sealed-secrets). The daemon can read them ONLY while the user
 * has an unlocked trading session: the browser/CLI sent the data key to the
 * control endpoint and it sits in unlockStore (memory, TTL). There is no
 * server master key and no SETTINGS_ENCRYPTION_KEY here any more.
 *
 * Lookup precedence:
 *   getUserSecret(K)  this user's unsealed secret blob only
 *   getUserPlain(K)   this user's plain blob only
 *   getSecret(K)      secret -> plain -> process.env, but a CREDENTIAL key
 *                     never falls back to process.env
 *   getPlain(K)       plain -> process.env -> fallback (non-secret knobs)
 *
 * The row is cached (ciphertext only) for CACHE_TTL_MS; plaintext secrets are
 * decrypted per load and never cached.
 *
 * loadUserConfigState() also reports whether the user is locked, so the
 * runtime can pause their workers with a visible status.
 *
 * Concurrency note: applyEnvOverlay() temporarily mutates process.env for the
 * duration of a tick so adapter code that reads process.env.X picks up the
 * user's values; overlays are serialized by a mutex.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ALL_OVERLAY_KEYS, SECRET_SET } from '@b1dz/core';
import {
  isInboxEntry,
  isSealRecord,
  openInbox,
  sealSecrets,
  unsealSecrets,
  verifyDataKey,
  type CipherBlob,
  type InboxEntry,
  type SealRecord,
} from '@b1dz/core/sealed-secrets';
import { unlockStore } from './unlock-store.js';

const CACHE_TTL_MS = 60_000;

interface UserSettingsRow {
  user_id: string;
  payload_plain: Record<string, unknown> | null;
  payload_secret_ciphertext: string | null;
  payload_secret_iv: string | null;
  payload_secret_tag: string | null;
  seal_version?: number | null;
  seal?: unknown;
  secret_inbox?: unknown;
  updated_at: string | null;
}

export interface UserConfig {
  readonly userId: string;
  /** secret blob -> plain blob -> process.env (non-credential keys only) -> fallback. */
  getSecret(key: string, fallback?: string): string | undefined;
  /** plain blob -> process.env -> fallback. (Skips secret blob.) */
  getPlain(key: string, fallback?: string): string | undefined;
  /** STRICT: this user's secret blob ONLY — no plain, no env. */
  getUserSecret(key: string): string | undefined;
  /** STRICT: this user's plain blob ONLY — no env. */
  getUserPlain(key: string): string | undefined;
  getNumber(key: string, fallback?: number): number | undefined;
  getBool(key: string, fallback?: boolean): boolean | undefined;
}

/**
 * - no-secrets: the user has no sealed secrets; workers run without credentials.
 * - unlocked:   sealed secrets are available for this tick.
 * - locked:     sealed secrets exist and no unlocked session; pause the user.
 * - legacy:     secrets are still under the old server key; pause until the
 *               user sets a passphrase on /settings (which migrates them).
 */
export type UserLockState = 'no-secrets' | 'unlocked' | 'locked' | 'legacy';

export interface UserConfigState {
  status: UserLockState;
  config: UserConfig;
  /** Human-readable reason shown in source status when paused. */
  reason?: string;
}

interface CacheEntry {
  expiresAt: number;
  row: UserSettingsRow | null;
}

const cache = new Map<string, CacheEntry>();

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
  const getUserSecret = (key: string): string | undefined => {
    const s = secretMap[key];
    return s !== undefined && s !== '' ? s : undefined;
  };
  const getUserPlain = (key: string): string | undefined => {
    const p = plainAsString(plainMap[key]);
    return p !== undefined && p !== '' ? p : undefined;
  };
  const getSecret = (key: string, fallback?: string): string | undefined => {
    const s = getUserSecret(key);
    if (s !== undefined) return s;
    // A credential never falls back to the operator's env (rule: no
    // operator-key fallback for user operations).
    if (CREDENTIAL_OVERLAY_KEYS.has(key)) return getUserPlain(key) ?? fallback;
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
  return Object.freeze({ userId, getSecret, getPlain, getUserSecret, getUserPlain, getNumber, getBool });
}

async function fetchRow(userId: string): Promise<UserSettingsRow | null> {
  const client = defaultClient();
  const { data, error } = await client
    .from('user_settings')
    .select('user_id, payload_plain, payload_secret_ciphertext, payload_secret_iv, payload_secret_tag, seal_version, seal, secret_inbox, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn(`user-config: fetch failed for ${userId.slice(0, 8)}: ${error.message}`);
    return null;
  }
  return (data as UserSettingsRow | null) ?? null;
}

async function cachedRow(userId: string): Promise<UserSettingsRow | null> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit.row;
  let row: UserSettingsRow | null = null;
  try {
    row = await fetchRow(userId);
  } catch (e) {
    console.warn(`user-config: load failed for ${userId.slice(0, 8)}: ${(e as Error).message}`);
  }
  cache.set(userId, { row, expiresAt: now + CACHE_TTL_MS });
  return row;
}

function rowCipher(row: UserSettingsRow | null): CipherBlob | null {
  if (!row?.payload_secret_ciphertext || !row.payload_secret_iv || !row.payload_secret_tag) return null;
  return { ciphertext: row.payload_secret_ciphertext, iv: row.payload_secret_iv, tag: row.payload_secret_tag };
}

function rowSeal(row: UserSettingsRow | null): SealRecord | null {
  return row && row.seal_version === 2 && isSealRecord(row.seal) ? row.seal : null;
}

function rowInbox(row: UserSettingsRow | null): InboxEntry[] {
  return Array.isArray(row?.secret_inbox) ? (row!.secret_inbox as unknown[]).filter(isInboxEntry) : [];
}

/** True when the row has secrets that need a user key (sealed or legacy). */
function hasSecrets(row: UserSettingsRow | null): boolean {
  return !!rowCipher(row) || rowInbox(row).length > 0;
}

/**
 * Load the per-user config plus lock state. Secrets are unsealed only when
 * the user has an unlocked session; pending OAuth inbox tokens are merged
 * into the sealed blob at the same time.
 */
export async function loadUserConfigState(userId: string): Promise<UserConfigState> {
  let row = await cachedRow(userId);
  const plain = row?.payload_plain ?? null;
  const seal = rowSeal(row);

  if (!seal) {
    if (rowCipher(row)) {
      return {
        status: 'legacy',
        config: buildConfig(userId, null, plain),
        reason: 'locked: set a passphrase at b1dz.com/settings to migrate your keys and resume',
      };
    }
    return { status: 'no-secrets', config: buildConfig(userId, null, plain) };
  }

  if (!hasSecrets(row)) return { status: 'no-secrets', config: buildConfig(userId, null, plain) };

  const dek = unlockStore.get(userId);
  if (!dek) {
    return {
      status: 'locked',
      config: buildConfig(userId, null, plain),
      reason: 'locked: unlock to resume (b1dz.com/settings or `b1dz unlock`)',
    };
  }

  let secret: Record<string, string> = {};
  const cipher = rowCipher(row);
  try {
    if (cipher) secret = await unsealSecrets(dek, cipher, userId);
  } catch {
    console.warn(`user-config: unseal failed for ${userId.slice(0, 8)} (stale key?) — locking`);
    unlockStore.lock(userId);
    return { status: 'locked', config: buildConfig(userId, null, plain), reason: 'locked: key no longer matches, unlock again' };
  }

  const inbox = rowInbox(row);
  if (inbox.length > 0) {
    try {
      const { patch, consumed } = await openInbox(dek, seal, inbox, userId);
      if (consumed.length > 0) {
        secret = { ...secret, ...patch };
        await writeSealed(userId, dek, secret, inbox.filter((e) => !consumed.includes(e.id)));
        row = await cachedRow(userId);
        console.log(`user-config: merged ${consumed.length} OAuth inbox entr${consumed.length === 1 ? 'y' : 'ies'} for ${userId.slice(0, 8)}…`);
      }
    } catch (e) {
      console.warn(`user-config: inbox merge failed for ${userId.slice(0, 8)}: ${(e as Error).message}`);
    }
  }

  return { status: 'unlocked', config: buildConfig(userId, secret, row?.payload_plain ?? plain) };
}

/** Back-compat: the config only (secrets empty when locked). */
export async function loadUserConfig(userId: string): Promise<UserConfig> {
  return (await loadUserConfigState(userId)).config;
}

/** Drop the cached row for a user — next load refetches. */
export function refreshUserConfig(userId: string): void {
  cache.delete(userId);
}

/** Control endpoint: is this the user's data key? (checked against seal.key_check) */
export async function verifyUnlockKey(userId: string, dek: Uint8Array): Promise<'ok' | 'no-seal' | 'bad-key'> {
  refreshUserConfig(userId);
  const seal = rowSeal(await cachedRow(userId));
  if (!seal) return 'no-seal';
  return (await verifyDataKey(dek, seal, userId)) ? 'ok' : 'bad-key';
}

async function writeSealed(userId: string, dek: Uint8Array, secret: Record<string, string>, inbox?: InboxEntry[]): Promise<void> {
  const blob = await sealSecrets(dek, secret, userId);
  const update: Record<string, unknown> = {
    payload_secret_ciphertext: blob.ciphertext,
    payload_secret_iv: blob.iv,
    payload_secret_tag: blob.tag,
    updated_at: new Date().toISOString(),
  };
  if (inbox) update.secret_inbox = inbox;
  const { error } = await defaultClient().from('user_settings').update(update).eq('user_id', userId).eq('seal_version', 2);
  if (error) throw new Error(error.message);
  refreshUserConfig(userId);
}

/**
 * Merge `patch` into the user's sealed secret blob and persist it. Used by
 * the OAuth auto-refresh. Requires an unlocked session (the data key); a
 * locked user's token is left to expire and they re-link or unlock.
 */
export async function mergeUserSecret(userId: string, patch: Record<string, string>): Promise<void> {
  const dek = unlockStore.get(userId);
  if (!dek) throw new Error('mergeUserSecret: user is locked');
  refreshUserConfig(userId);
  const row = await cachedRow(userId);
  if (!rowSeal(row)) throw new Error('mergeUserSecret: user has no sealed settings');
  const cipher = rowCipher(row);
  const existing = cipher ? await unsealSecrets(dek, cipher, userId) : {};
  await writeSealed(userId, dek, { ...existing, ...patch });
}

/**
 * Operator scripts (apps/daemon/scripts/*): unlock a user in THIS process
 * from B1DZ_VAULT_PASSPHRASE (or a prompt-supplied passphrase). Same rules as
 * the daemon: memory only, short TTL.
 */
export async function unlockWithPassphraseForScript(userId: string, passphrase = process.env.B1DZ_VAULT_PASSPHRASE): Promise<void> {
  if (!passphrase) throw new Error('set B1DZ_VAULT_PASSPHRASE to unlock this user for the script');
  refreshUserConfig(userId);
  const seal = rowSeal(await cachedRow(userId));
  if (!seal) throw new Error('user has no sealed settings (set a passphrase at b1dz.com/settings)');
  const { unlockSeal } = await import('@b1dz/core/sealed-secrets');
  const dek = await unlockSeal(seal, passphrase, userId);
  unlockStore.unlock(userId, dek, 15 * 60);
  dek.fill(0);
}

/** Test hook: drop all cached entries. */
export function clearUserConfigCacheForTesting(): void {
  cache.clear();
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

/** Operator service credentials that do not hold or move user funds (data
 *  APIs, egress proxy, inference). They stay in env for the operator's own
 *  infrastructure; the per-tick overlay still strips them for users. */
const OPERATOR_SERVICE_KEYS = new Set<string>([
  'PROXY_USERNAME',
  'PROXY_PASSWORD',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'ONEINCH_API_KEY',
  'ZEROX_API_KEY',
  'PUMPPORTAL_API_KEY',
]);

/** Credential key names (for tests and the startup scrub). */
export function credentialKeys(): readonly string[] {
  return [...CREDENTIAL_OVERLAY_KEYS];
}

/**
 * Remove operator wallet keys and exchange secrets (SOLANA_PRIVATE_KEY,
 * EVM_PRIVATE_KEY, Coinbase/Kraken/Binance.US/Gemini) from process.env at daemon start, so no code path can fall
 * back to them. The operator trades as a normal user who unlocks. Returns the
 * NAMES removed (never values).
 */
export function scrubOperatorCredentialEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const k of CREDENTIAL_OVERLAY_KEYS) {
    if (OPERATOR_SERVICE_KEYS.has(k)) continue;
    if (env[k] !== undefined) {
      delete env[k];
      removed.push(k);
    }
  }
  return removed;
}

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
