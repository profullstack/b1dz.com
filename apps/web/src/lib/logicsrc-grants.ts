/**
 * Keys from logicsrc, through the house package @profullstack/key-grants.
 *
 * b1dz's part is only the wiring:
 *   - a person's recipient is their vault's inbox key (user_settings.seal,
 *     sealer app "b1dz", scope "user_settings", user id = Supabase auth id);
 *   - a delivered key is a `sealed:v2:<inbox entry JSON>` the person's browser
 *     sealed on logicsrc. It is queued in user_settings.secret_inbox exactly like
 *     an OAuth token, tagged with the one key it may set, and merged into the
 *     sealed secret blob the next time the vault is unlocked (web, CLI, daemon);
 *   - a revoke drops any still-queued logicsrc entry for that key and queues a
 *     sealed blank for it, so the next unlock clears the key.
 * The server can write these entries; it can never read them.
 *
 * Requests and grants (nonces, per-request webhook secrets, grant ids, never a
 * key) live in kg_grant_requests / kg_grants, service role only.
 */
import { createKeyGrants, type KeyGrantStore, type GrantRequestRow, type GrantRow } from '@profullstack/key-grants';
import { isInboxEntry, sealToInbox, type InboxEntry } from '@b1dz/core/sealed-secrets';
import { createAdminSupabase } from '@/lib/supabase';
import { loadSettingsRow, rowInbox, rowSeal } from '@/lib/settings-row';
import { isGrantableKey } from '@/lib/logicsrc-keys';

export const SEALED_PREFIX = 'sealed:v2:';
export const INBOX_LIMIT = 20;

// Read through a non-literal key: Next inlines `process.env.NAME` at build time.
const env = (name: string) => process.env[name];

/** The subset of a supabase-js client this module uses (lets tests pass a fake). */
export interface Db {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const num = <T extends { created_at?: unknown; expires_at?: unknown; updated_at?: unknown }>(r: T | null): T | null =>
  r && ({
    ...r,
    ...(r.created_at != null ? { created_at: Number(r.created_at) } : {}),
    ...(r.expires_at != null ? { expires_at: Number(r.expires_at) } : {}),
    ...(r.updated_at != null ? { updated_at: Number(r.updated_at) } : {}),
  } as T);

/** KeyGrantStore over the kg_* tables (see supabase/migrations/*_logicsrc_key_grants.sql). */
export function supabaseStore(db: Db): KeyGrantStore {
  const must = <T>({ data, error }: { data: T; error: { message: string } | null }): T => {
    if (error) throw new Error(`kg store: ${error.message}`);
    return data;
  };
  return {
    async saveRequest(row) {
      must(await db.from('kg_grant_requests').insert(row));
    },
    async getRequest(nonce) {
      return num(must(await db.from('kg_grant_requests').select('*').eq('nonce', nonce).maybeSingle()) as GrantRequestRow | null);
    },
    async requestsForUser(userId, limit) {
      if (!/^[0-9a-f-]{36}$/i.test(userId)) return [];
      const rows = must(await db.from('kg_grant_requests').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit)) as GrantRequestRow[] | null;
      return (rows ?? []).map((r) => num(r)!);
    },
    async getGrant(grantId) {
      return num(must(await db.from('kg_grants').select('*').eq('grant_id', grantId).maybeSingle()) as GrantRow | null);
    },
    async saveGrant(row) {
      must(await db.from('kg_grants').upsert(row, { onConflict: 'grant_id' }));
    },
  };
}

async function writeInbox(db: Db, userId: string, inbox: InboxEntry[]): Promise<void> {
  const { error } = await db.from('user_settings').upsert(
    { user_id: userId, secret_inbox: inbox.slice(-INBOX_LIMIT), updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(`inbox write: ${error.message}`);
}

/** `sealed:v2:<json>` from logicsrc -> an inbox entry, or null when it is not one. */
export function parseSealedEntry(sealed: string): InboxEntry | null {
  if (!sealed.startsWith(SEALED_PREFIX)) return null;
  try {
    const e = JSON.parse(sealed.slice(SEALED_PREFIX.length)) as unknown;
    if (!isInboxEntry(e)) return null;
    // Keep only the sealed fields; anything else in the JSON is not ours to store.
    return { id: e.id, epk: e.epk, blob: { ciphertext: e.blob.ciphertext, iv: e.blob.iv, tag: e.blob.tag }, created_at: e.created_at };
  } catch {
    return null;
  }
}

const isLogicsrcEntryFor = (e: InboxEntry, keyName: string) =>
  e.source === 'logicsrc' && Array.isArray(e.keys) && e.keys.length === 1 && e.keys[0] === keyName;

export function b1dzKeyGrants({
  db = createAdminSupabase() as unknown as Db,
  origin = env('NEXT_PUBLIC_SITE_URL') || 'https://b1dz.com',
  logicsrcUrl = env('LOGICSRC_URL') || undefined,
  now,
}: { db?: Db; origin?: string; logicsrcUrl?: string; now?: () => number } = {}) {
  return createKeyGrants({
    appName: 'b1dz',
    origin,
    logicsrcUrl,
    now,
    store: supabaseStore(db),
    describeKey: () => 'Used by your b1dz strategies and AI analyzer; opens only while your b1dz vault is unlocked',
    recipientFor: async (userId) => {
      const seal = rowSeal(await loadSettingsRow(db, userId));
      return seal ? { app: 'b1dz', scope: 'user_settings', user_id: userId, inbox_public_key: seal.inbox_public_key } : null;
    },
    onKey: async ({ userId, keyName, sealed }) => {
      if (!isGrantableKey(keyName)) {
        console.warn(`[logicsrc] refused ${keyName} for ${userId.slice(0, 8)}…: not a grantable b1dz key`);
        return;
      }
      const entry = parseSealedEntry(sealed);
      if (!entry) throw new Error('logicsrc sent a value that is not a b1dz inbox entry');
      const row = await loadSettingsRow(db, userId);
      // A rotation replaces the still-queued older value for the same key.
      const inbox = rowInbox(row).filter((e) => !isLogicsrcEntryFor(e, keyName));
      await writeInbox(db, userId, [...inbox, { ...entry, keys: [keyName], source: 'logicsrc' }]);
      console.log(`[logicsrc] queued ${keyName} for ${userId.slice(0, 8)}…`);
    },
    onRevoke: async ({ userId, keyName }) => {
      if (!isGrantableKey(keyName)) return;
      const row = await loadSettingsRow(db, userId);
      const seal = rowSeal(row);
      const inbox = rowInbox(row).filter((e) => !isLogicsrcEntryFor(e, keyName));
      if (!seal) return writeInbox(db, userId, inbox);
      // A blank value is "not set" everywhere b1dz reads secrets; the next unlock clears it.
      const blank = await sealToInbox(seal.inbox_public_key, { [keyName]: '' }, userId);
      await writeInbox(db, userId, [...inbox, { ...blank, keys: [keyName], source: 'logicsrc' }]);
      console.log(`[logicsrc] revoked ${keyName} for ${userId.slice(0, 8)}…`);
    },
  });
}

let shared: ReturnType<typeof b1dzKeyGrants> | null = null;
export const keyGrants = () => (shared ??= b1dzKeyGrants());
