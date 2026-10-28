/**
 * user-config: sealed secrets open only while the user is unlocked, lock
 * states, no operator-env fallback for credentials, caching, env overlay,
 * OAuth inbox merge, and the startup credential scrub.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import {
  applyEnvOverlay,
  clearUserConfigCacheForTesting,
  loadUserConfig,
  loadUserConfigState,
  mergeUserSecret,
  refreshUserConfig,
  scrubOperatorCredentialEnv,
  setSupabaseClientForTesting,
  verifyUnlockKey,
  __getOverlayKeysForTesting,
} from './user-config.js';
import { unlockStore } from './unlock-store.js';
import {
  SECRET_FIELDS,
  PLAIN_STRING_FIELDS,
  PLAIN_NUMBER_FIELDS,
  PLAIN_BOOL_FIELDS,
} from '@b1dz/core';
import { createSeal, sealSecrets, sealToInbox, unsealSecrets, type SealRecord } from '@b1dz/core/sealed-secrets';

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';

interface FakeRow {
  user_id: string;
  payload_plain: Record<string, unknown> | null;
  payload_secret_ciphertext: string | null;
  payload_secret_iv: string | null;
  payload_secret_tag: string | null;
  seal_version?: number;
  seal?: unknown;
  secret_inbox?: unknown;
  updated_at: string | null;
}

function fakeClient(rows: FakeRow[]) {
  let count = 0;
  return {
    fetchCount: () => count,
    client: {
      from: () => ({
        select: () => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () => {
              count += 1;
              const r = rows.find((x) => x.user_id === val);
              return { data: r ? structuredClone(r) : null, error: null };
            },
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_c: string, val: string) => ({
            eq: async () => {
              const r = rows.find((x) => x.user_id === val);
              if (r) Object.assign(r, patch);
              return { error: null };
            },
          }),
        }),
      }),
    },
  };
}

const seals: Record<string, { dek: Uint8Array; seal: SealRecord }> = {};

beforeAll(async () => {
  for (const u of [U1, U2]) {
    const { dek, seal } = await createSeal('test passphrase 123', u);
    seals[u] = { dek, seal };
  }
}, 30_000);

async function sealedRow(userId: string, secret: Record<string, string>, extra: Partial<FakeRow> = {}): Promise<FakeRow> {
  const blob = await sealSecrets(seals[userId].dek, secret, userId);
  return {
    user_id: userId,
    payload_plain: null,
    payload_secret_ciphertext: blob.ciphertext,
    payload_secret_iv: blob.iv,
    payload_secret_tag: blob.tag,
    seal_version: 2,
    seal: seals[userId].seal,
    secret_inbox: [],
    updated_at: null,
    ...extra,
  };
}

function legacyRow(userId: string, secret: Record<string, string>): FakeRow {
  const master = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', createHmac('sha256', master).update(userId).digest(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(secret), 'utf8'), c.final()]);
  return {
    user_id: userId,
    payload_plain: null,
    payload_secret_ciphertext: ct.toString('base64'),
    payload_secret_iv: iv.toString('base64'),
    payload_secret_tag: c.getAuthTag().toString('base64'),
    seal_version: 1,
    updated_at: null,
  };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  clearUserConfigCacheForTesting();
  unlockStore.lockAll();
  process.env = { ...OLD_ENV };
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  setSupabaseClientForTesting(null);
  clearUserConfigCacheForTesting();
  unlockStore.lockAll();
});

describe('lock states', () => {
  it('no row: no-secrets, runs', async () => {
    setSupabaseClientForTesting(fakeClient([]).client as never);
    expect((await loadUserConfigState(U1)).status).toBe('no-secrets');
  });

  it('sealed row and no session: locked, secrets empty, with a visible reason', async () => {
    setSupabaseClientForTesting(fakeClient([await sealedRow(U1, { KRAKEN_API_KEY: 'k' })]).client as never);
    const st = await loadUserConfigState(U1);
    expect(st.status).toBe('locked');
    expect(st.reason).toMatch(/unlock to resume/);
    expect(st.config.getUserSecret('KRAKEN_API_KEY')).toBeUndefined();
  });

  it('sealed row and unlocked: secrets available', async () => {
    setSupabaseClientForTesting(fakeClient([await sealedRow(U1, { KRAKEN_API_KEY: 'user-kraken' })]).client as never);
    unlockStore.unlock(U1, seals[U1].dek, 3600);
    const st = await loadUserConfigState(U1);
    expect(st.status).toBe('unlocked');
    expect(st.config.getSecret('KRAKEN_API_KEY')).toBe('user-kraken');
  });

  it('lock takes effect on the next load (row cached, plaintext is not)', async () => {
    setSupabaseClientForTesting(fakeClient([await sealedRow(U1, { KRAKEN_API_KEY: 'x' })]).client as never);
    unlockStore.unlock(U1, seals[U1].dek, 3600);
    expect((await loadUserConfigState(U1)).status).toBe('unlocked');
    unlockStore.lock(U1);
    expect((await loadUserConfigState(U1)).status).toBe('locked');
  });

  it('another user\'s key does not open the blob: locks instead of crashing', async () => {
    setSupabaseClientForTesting(fakeClient([await sealedRow(U1, { KRAKEN_API_KEY: 'x' })]).client as never);
    unlockStore.unlock(U1, seals[U2].dek, 3600);
    const st = await loadUserConfigState(U1);
    expect(st.status).toBe('locked');
    expect(unlockStore.status(U1).unlocked).toBe(false);
  });

  it('legacy (server-key) row: paused as legacy, never decrypted, even with SETTINGS_ENCRYPTION_KEY set', async () => {
    process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    setSupabaseClientForTesting(fakeClient([legacyRow(U1, { SOLANA_PRIVATE_KEY: 'k' })]).client as never);
    const st = await loadUserConfigState(U1);
    expect(st.status).toBe('legacy');
    expect(st.reason).toMatch(/passphrase/);
    expect(st.config.getUserSecret('SOLANA_PRIVATE_KEY')).toBeUndefined();
  });
});

describe('no operator env fallback', () => {
  it('credential keys never fall back to process.env', async () => {
    process.env.SOLANA_PRIVATE_KEY = 'operator-sol';
    process.env.EVM_PRIVATE_KEY = 'operator-evm';
    process.env.KRAKEN_API_SECRET = 'operator-kraken';
    setSupabaseClientForTesting(fakeClient([]).client as never);
    const cfg = await loadUserConfig(U1);
    expect(cfg.getSecret('SOLANA_PRIVATE_KEY')).toBeUndefined();
    expect(cfg.getSecret('EVM_PRIVATE_KEY')).toBeUndefined();
    expect(cfg.getSecret('KRAKEN_API_SECRET')).toBeUndefined();
  });

  it('overlay strips operator credentials for a user without their own', async () => {
    process.env.SOLANA_PRIVATE_KEY = 'operator-sol';
    setSupabaseClientForTesting(fakeClient([]).client as never);
    const cfg = await loadUserConfig(U1);
    let inside: string | undefined = 'unset';
    await applyEnvOverlay(cfg, async () => { inside = process.env.SOLANA_PRIVATE_KEY; });
    expect(inside).toBeUndefined();
  });

  it('non-credential knobs still use the operator default', async () => {
    process.env.DAILY_LOSS_LIMIT_PCT = '7';
    setSupabaseClientForTesting(fakeClient([]).client as never);
    const cfg = await loadUserConfig(U1);
    expect(cfg.getNumber('DAILY_LOSS_LIMIT_PCT')).toBe(7);
  });

  it('startup scrub removes wallet keys and exchange secrets from env, returns names only', () => {
    const env: NodeJS.ProcessEnv = {
      SOLANA_PRIVATE_KEY: 's', EVM_PRIVATE_KEY: 'e', GEMINI_API_SECRET: 'g', COINBASE_API_PRIVATE_KEY_B64: 'c',
      PROXY_PASSWORD: 'p', SUPABASE_SECRET_KEY: 'db', BASE_RPC_URL: 'r', X402_PRIVATE_KEY: 'x',
    };
    const removed = scrubOperatorCredentialEnv(env);
    // The x402 payer key is a wallet key too: the operator's copy is scrubbed and
    // only an unlocked user's sealed X402_PRIVATE_KEY reaches a tick.
    expect(removed.sort()).toEqual(['COINBASE_API_PRIVATE_KEY_B64', 'EVM_PRIVATE_KEY', 'GEMINI_API_SECRET', 'SOLANA_PRIVATE_KEY', 'X402_PRIVATE_KEY']);
    expect(env.SOLANA_PRIVATE_KEY).toBeUndefined();
    expect(env.PROXY_PASSWORD).toBe('p');
    expect(env.SUPABASE_SECRET_KEY).toBe('db');
    expect(removed.join()).not.toContain('s,');
  });
});

describe('unlock key verification', () => {
  it('accepts the right key, rejects a wrong one, reports no-seal', async () => {
    setSupabaseClientForTesting(fakeClient([await sealedRow(U1, {}), legacyRow(U2, { a: 'b' })]).client as never);
    expect(await verifyUnlockKey(U1, seals[U1].dek)).toBe('ok');
    expect(await verifyUnlockKey(U1, seals[U2].dek)).toBe('bad-key');
    expect(await verifyUnlockKey(U2, seals[U2].dek)).toBe('no-seal');
  });
});

describe('OAuth inbox + token refresh', () => {
  it('merges inbox tokens into the sealed blob while unlocked and clears them', async () => {
    const entry = await sealToInbox(seals[U1].seal.inbox_public_key, { ALPACA_OAUTH_TOKEN: 'fresh' }, U1);
    const row = await sealedRow(U1, { KRAKEN_API_KEY: 'k' }, { secret_inbox: [entry] });
    setSupabaseClientForTesting(fakeClient([row]).client as never);

    // locked: inbox waits
    expect((await loadUserConfigState(U1)).status).toBe('locked');
    expect((row.secret_inbox as unknown[]).length).toBe(1);

    unlockStore.unlock(U1, seals[U1].dek, 3600);
    refreshUserConfig(U1);
    const st = await loadUserConfigState(U1);
    expect(st.config.getUserSecret('ALPACA_OAUTH_TOKEN')).toBe('fresh');
    expect(st.config.getUserSecret('KRAKEN_API_KEY')).toBe('k');
    expect(row.secret_inbox).toEqual([]);
    const stored = await unsealSecrets(seals[U1].dek, { ciphertext: row.payload_secret_ciphertext!, iv: row.payload_secret_iv!, tag: row.payload_secret_tag! }, U1);
    expect(stored.ALPACA_OAUTH_TOKEN).toBe('fresh');
  });

  it('mergeUserSecret requires an unlocked session', async () => {
    const row = await sealedRow(U1, { A: '1' });
    setSupabaseClientForTesting(fakeClient([row]).client as never);
    await expect(mergeUserSecret(U1, { B: '2' })).rejects.toThrow(/locked/);
    unlockStore.unlock(U1, seals[U1].dek, 3600);
    await mergeUserSecret(U1, { B: '2' });
    const stored = await unsealSecrets(seals[U1].dek, { ciphertext: row.payload_secret_ciphertext!, iv: row.payload_secret_iv!, tag: row.payload_secret_tag! }, U1);
    expect(stored).toEqual({ A: '1', B: '2' });
  });
});

describe('caching', () => {
  it('cache hit within TTL does not re-fetch', async () => {
    const { client, fetchCount } = fakeClient([]);
    setSupabaseClientForTesting(client as never);
    await loadUserConfig(U1);
    await loadUserConfig(U1);
    expect(fetchCount()).toBe(1);
  });

  it('refreshUserConfig invalidates the cache', async () => {
    const { client, fetchCount } = fakeClient([]);
    setSupabaseClientForTesting(client as never);
    await loadUserConfig(U1);
    refreshUserConfig(U1);
    await loadUserConfig(U1);
    expect(fetchCount()).toBe(2);
  });
});

describe('applyEnvOverlay', () => {
  it('temporarily overlays unlocked user secrets on process.env, then restores', async () => {
    delete process.env.KRAKEN_API_KEY;
    setSupabaseClientForTesting(fakeClient([await sealedRow(U1, { KRAKEN_API_KEY: 'user-kraken' })]).client as never);
    unlockStore.unlock(U1, seals[U1].dek, 3600);
    const cfg = await loadUserConfig(U1);
    let inside: string | undefined;
    await applyEnvOverlay(cfg, async () => { inside = process.env.KRAKEN_API_KEY; });
    expect(inside).toBe('user-kraken');
    expect(process.env.KRAKEN_API_KEY).toBeUndefined();
  });

  it('restores env even if the callback throws', async () => {
    process.env.BASE_RPC_URL = 'safe';
    setSupabaseClientForTesting(fakeClient([]).client as never);
    const cfg = await loadUserConfig(U1);
    await expect(applyEnvOverlay(cfg, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(process.env.BASE_RPC_URL).toBe('safe');
  });
});

describe('OVERLAY_KEYS coverage', () => {
  it('includes every catalog key from @b1dz/core/settings-fields', () => {
    const overlay = new Set(__getOverlayKeysForTesting());
    const all = [...SECRET_FIELDS, ...PLAIN_STRING_FIELDS, ...PLAIN_NUMBER_FIELDS, ...PLAIN_BOOL_FIELDS];
    expect(all.filter((k) => !overlay.has(k))).toEqual([]);
  });

  it('overlays a user-saved BASE_RPC_URL onto process.env at tick time', async () => {
    delete process.env.BASE_RPC_URL;
    setSupabaseClientForTesting(fakeClient([{
      user_id: U1, payload_plain: { BASE_RPC_URL: 'https://user-set-base-rpc.example' },
      payload_secret_ciphertext: null, payload_secret_iv: null, payload_secret_tag: null, updated_at: null,
    }]).client as never);
    const cfg = await loadUserConfig(U1);
    let observed: string | undefined;
    await applyEnvOverlay(cfg, async () => { observed = process.env.BASE_RPC_URL; });
    expect(observed).toBe('https://user-set-base-rpc.example');
    expect(process.env.BASE_RPC_URL).toBeUndefined();
  });
});
