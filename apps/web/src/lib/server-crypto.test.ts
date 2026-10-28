import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { decryptLegacySecret, legacyMigrationEnabled } from './server-crypto';
import * as mod from './server-crypto';

function legacyEncrypt(obj: unknown, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

const saved = { ...process.env };
let master: Buffer;

beforeEach(() => {
  master = randomBytes(32);
  process.env.SETTINGS_ENCRYPTION_KEY = master.toString('base64');
  delete process.env.LEGACY_KEY_MIGRATION;
});
afterEach(() => { process.env = { ...saved }; });

describe('server-crypto (legacy migration only)', () => {
  it('exposes no way to encrypt or hand out a key', () => {
    expect(Object.keys(mod).sort()).toEqual(['decryptLegacySecret', 'legacyMigrationEnabled']);
  });

  it('decrypts per-user (HMAC) legacy blobs for their owner', () => {
    const perUser = createHmac('sha256', master).update('user-a').digest();
    const blob = legacyEncrypt({ SOLANA_PRIVATE_KEY: 'k' }, perUser);
    expect(decryptLegacySecret(blob, 'user-a')).toEqual({ SOLANA_PRIVATE_KEY: 'k' });
    expect(() => decryptLegacySecret(blob, 'user-b')).toThrow();
  });

  it('decrypts the oldest master-key blobs', () => {
    expect(decryptLegacySecret(legacyEncrypt({ k: 'legacy' }, master), 'user-a')).toEqual({ k: 'legacy' });
  });

  it('is closed by LEGACY_KEY_MIGRATION=off (the cutoff switch)', () => {
    process.env.LEGACY_KEY_MIGRATION = 'off';
    expect(legacyMigrationEnabled()).toBe(false);
    expect(() => decryptLegacySecret(legacyEncrypt({ k: 'v' }, master), 'user-a')).toThrow(/closed/);
  });

  it('is closed when the legacy key is gone', () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    expect(legacyMigrationEnabled()).toBe(false);
  });

  it('returns {} for an absent blob', () => {
    expect(decryptLegacySecret(null, 'user-a')).toEqual({});
  });
});
