import { describe, it, expect, beforeAll } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';

let encryptSecret: typeof import('./server-crypto').encryptSecret;
let decryptSecret: typeof import('./server-crypto').decryptSecret;
let decryptCurrentUserSecret: typeof import('./server-crypto').decryptCurrentUserSecret;
let deriveUserSecretKey: typeof import('./server-crypto').deriveUserSecretKey;

beforeAll(async () => {
  process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  const mod = await import('./server-crypto');
  encryptSecret = mod.encryptSecret;
  decryptSecret = mod.decryptSecret;
  decryptCurrentUserSecret = mod.decryptCurrentUserSecret;
  deriveUserSecretKey = mod.deriveUserSecretKey;
});

describe('server-crypto', () => {
  it('round-trips a secret object', () => {
    const blob = encryptSecret({ ALPACA_OAUTH_TOKEN: 'tok-123', TRADIER_ACCESS_TOKEN: 'abc' }, 'user-a');
    expect(blob.ciphertext.length).toBeGreaterThan(0);
    expect(blob.iv.length).toBeGreaterThan(0);
    expect(blob.tag.length).toBeGreaterThan(0);
    expect(decryptSecret(blob, 'user-a')).toEqual({ ALPACA_OAUTH_TOKEN: 'tok-123', TRADIER_ACCESS_TOKEN: 'abc' });
  });

  it('produces a fresh IV each time (non-deterministic ciphertext)', () => {
    const a = encryptSecret({ k: 'v' }, 'user-a');
    const b = encryptSecret({ k: 'v' }, 'user-a');
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('returns {} for an empty/absent blob', () => {
    expect(decryptSecret(null, 'user-a')).toEqual({});
  });

  it('fails authentication on a tampered tag', () => {
    const blob = encryptSecret({ k: 'v' }, 'user-a');
    const tampered = { ...blob, tag: Buffer.from(randomBytes(16)).toString('base64') };
    expect(() => decryptSecret(tampered, 'user-a')).toThrow();
  });

  it('derives different keys for different users', () => {
    expect(deriveUserSecretKey('user-a').equals(deriveUserSecretKey('user-b'))).toBe(false);
  });

  it('does not decrypt another user secret with the current-user key', () => {
    const blob = encryptSecret({ k: 'v' }, 'user-a');
    expect(() => decryptCurrentUserSecret(blob, 'user-b')).toThrow();
  });

  it('can decrypt legacy master-key blobs for migration', () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(process.env.SETTINGS_ENCRYPTION_KEY!, 'base64'), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ k: 'legacy' }), 'utf8'), cipher.final()]);
    const blob = {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };

    expect(decryptSecret(blob, 'user-a')).toEqual({ k: 'legacy' });
  });
});
