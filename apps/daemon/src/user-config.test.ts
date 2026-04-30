/**
 * Tests for user-config: lookup precedence, decrypt round-trip, caching,
 * cache invalidation, and the env overlay.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  applyEnvOverlay,
  clearUserConfigCacheForTesting,
  loadUserConfig,
  refreshUserConfig,
  setSupabaseClientForTesting,
} from './user-config.js';

interface FakeRow {
  user_id: string;
  payload_plain: Record<string, unknown> | null;
  payload_secret_ciphertext: string | null;
  payload_secret_iv: string | null;
  payload_secret_tag: string | null;
  updated_at: string | null;
}

function fakeClient(rows: FakeRow[]): {
  client: { from: (t: string) => { select: (s: string) => { eq: (col: string, val: string) => { maybeSingle: () => Promise<{ data: FakeRow | null; error: null }> } } } };
  fetchCount: () => number;
} {
  let count = 0;
  return {
    fetchCount: () => count,
    client: {
      from: () => ({
        select: () => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () => {
              count += 1;
              return { data: rows.find((r) => r.user_id === val) ?? null, error: null };
            },
          }),
        }),
      }),
    },
  };
}

const TEST_KEY = randomBytes(32);

function encryptForTest(secret: Record<string, string>): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', TEST_KEY, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  clearUserConfigCacheForTesting();
  process.env = { ...OLD_ENV, SETTINGS_ENCRYPTION_KEY: TEST_KEY.toString('base64') };
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  setSupabaseClientForTesting(null);
  clearUserConfigCacheForTesting();
});

describe('loadUserConfig — lookup precedence', () => {
  it('returns process.env when no row exists', async () => {
    process.env.KRAKEN_API_KEY = 'env-kraken';
    const { client } = fakeClient([]);
    setSupabaseClientForTesting(client as never);

    const cfg = await loadUserConfig('user-no-row');
    expect(cfg.getSecret('KRAKEN_API_KEY')).toBe('env-kraken');
  });

  it('returns the fallback arg when neither row nor env has the key', async () => {
    delete process.env.MISSING_KEY;
    const { client } = fakeClient([]);
    setSupabaseClientForTesting(client as never);

    const cfg = await loadUserConfig('u');
    expect(cfg.getSecret('MISSING_KEY', 'fallback')).toBe('fallback');
  });

  it('decrypted secret takes precedence over process.env', async () => {
    process.env.KRAKEN_API_KEY = 'env-kraken';
    const blob = encryptForTest({ KRAKEN_API_KEY: 'user-kraken-from-db' });
    const { client } = fakeClient([{
      user_id: 'u1',
      payload_plain: null,
      payload_secret_ciphertext: blob.ciphertext,
      payload_secret_iv: blob.iv,
      payload_secret_tag: blob.tag,
      updated_at: null,
    }]);
    setSupabaseClientForTesting(client as never);

    const cfg = await loadUserConfig('u1');
    expect(cfg.getSecret('KRAKEN_API_KEY')).toBe('user-kraken-from-db');
  });

  it('plain overrides take precedence over process.env (for non-secret keys)', async () => {
    process.env.DAILY_LOSS_LIMIT_PCT = '5';
    const { client } = fakeClient([{
      user_id: 'u2',
      payload_plain: { DAILY_LOSS_LIMIT_PCT: '12.5' },
      payload_secret_ciphertext: null,
      payload_secret_iv: null,
      payload_secret_tag: null,
      updated_at: null,
    }]);
    setSupabaseClientForTesting(client as never);

    const cfg = await loadUserConfig('u2');
    expect(cfg.getNumber('DAILY_LOSS_LIMIT_PCT')).toBe(12.5);
    expect(cfg.getPlain('DAILY_LOSS_LIMIT_PCT')).toBe('12.5');
  });

  it('parses booleans from plain and env', async () => {
    process.env.MARGIN_TRADING = 'false';
    const { client } = fakeClient([{
      user_id: 'u3',
      payload_plain: { DEX_TRADE_EXECUTION: 'true' },
      payload_secret_ciphertext: null,
      payload_secret_iv: null,
      payload_secret_tag: null,
      updated_at: null,
    }]);
    setSupabaseClientForTesting(client as never);

    const cfg = await loadUserConfig('u3');
    expect(cfg.getBool('DEX_TRADE_EXECUTION')).toBe(true);
    expect(cfg.getBool('MARGIN_TRADING')).toBe(false);
    expect(cfg.getBool('UNSET_FLAG', true)).toBe(true);
  });
});

describe('loadUserConfig — caching', () => {
  it('cache hit within TTL does not re-fetch', async () => {
    const { client, fetchCount } = fakeClient([]);
    setSupabaseClientForTesting(client as never);

    await loadUserConfig('cached');
    await loadUserConfig('cached');
    await loadUserConfig('cached');

    expect(fetchCount()).toBe(1);
  });

  it('refreshUserConfig invalidates the cache', async () => {
    const { client, fetchCount } = fakeClient([]);
    setSupabaseClientForTesting(client as never);

    await loadUserConfig('refresh-me');
    refreshUserConfig('refresh-me');
    await loadUserConfig('refresh-me');

    expect(fetchCount()).toBe(2);
  });
});

describe('applyEnvOverlay', () => {
  it('temporarily overlays user secrets on process.env, then restores', async () => {
    process.env.KRAKEN_API_KEY = 'env-original';
    delete process.env.GEMINI_API_KEY;

    const blob = encryptForTest({
      KRAKEN_API_KEY: 'user-kraken',
      GEMINI_API_KEY: 'user-gemini',
    });
    const { client } = fakeClient([{
      user_id: 'overlay-user',
      payload_plain: null,
      payload_secret_ciphertext: blob.ciphertext,
      payload_secret_iv: blob.iv,
      payload_secret_tag: blob.tag,
      updated_at: null,
    }]);
    setSupabaseClientForTesting(client as never);

    const cfg = await loadUserConfig('overlay-user');

    let inside: { kraken?: string; gemini?: string } = {};
    await applyEnvOverlay(cfg, async () => {
      inside = {
        kraken: process.env.KRAKEN_API_KEY,
        gemini: process.env.GEMINI_API_KEY,
      };
    });

    expect(inside.kraken).toBe('user-kraken');
    expect(inside.gemini).toBe('user-gemini');
    // Restored
    expect(process.env.KRAKEN_API_KEY).toBe('env-original');
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
  });

  it('restores env even if the callback throws', async () => {
    process.env.KRAKEN_API_KEY = 'safe';
    const blob = encryptForTest({ KRAKEN_API_KEY: 'temp' });
    const { client } = fakeClient([{
      user_id: 'throws',
      payload_plain: null,
      payload_secret_ciphertext: blob.ciphertext,
      payload_secret_iv: blob.iv,
      payload_secret_tag: blob.tag,
      updated_at: null,
    }]);
    setSupabaseClientForTesting(client as never);

    const cfg = await loadUserConfig('throws');
    await expect(
      applyEnvOverlay(cfg, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(process.env.KRAKEN_API_KEY).toBe('safe');
  });
});

describe('loadUserConfig — degraded mode (no encryption key)', () => {
  it('returns env-only when SETTINGS_ENCRYPTION_KEY is missing', async () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    process.env.KRAKEN_API_KEY = 'env-only';

    // Even if the row has a secret blob, without a key we can't decrypt — env should still come through.
    const blob = encryptForTest({ KRAKEN_API_KEY: 'user-from-db' });
    const { client } = fakeClient([{
      user_id: 'no-key',
      payload_plain: null,
      payload_secret_ciphertext: blob.ciphertext,
      payload_secret_iv: blob.iv,
      payload_secret_tag: blob.tag,
      updated_at: null,
    }]);
    setSupabaseClientForTesting(client as never);

    const cfg = await loadUserConfig('no-key');
    expect(cfg.getSecret('KRAKEN_API_KEY')).toBe('env-only');
  });
});
