import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';

let encryptSecret: typeof import('./server-crypto').encryptSecret;
let decryptSecret: typeof import('./server-crypto').decryptSecret;

beforeAll(async () => {
  process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  const mod = await import('./server-crypto');
  encryptSecret = mod.encryptSecret;
  decryptSecret = mod.decryptSecret;
});

describe('server-crypto', () => {
  it('round-trips a secret object', () => {
    const blob = encryptSecret({ ALPACA_OAUTH_TOKEN: 'tok-123', TRADIER_ACCESS_TOKEN: 'abc' });
    expect(blob.ciphertext.length).toBeGreaterThan(0);
    expect(blob.iv.length).toBeGreaterThan(0);
    expect(blob.tag.length).toBeGreaterThan(0);
    expect(decryptSecret(blob)).toEqual({ ALPACA_OAUTH_TOKEN: 'tok-123', TRADIER_ACCESS_TOKEN: 'abc' });
  });

  it('produces a fresh IV each time (non-deterministic ciphertext)', () => {
    const a = encryptSecret({ k: 'v' });
    const b = encryptSecret({ k: 'v' });
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('returns {} for an empty/absent blob', () => {
    expect(decryptSecret(null)).toEqual({});
  });

  it('fails authentication on a tampered tag', () => {
    const blob = encryptSecret({ k: 'v' });
    const tampered = { ...blob, tag: Buffer.from(randomBytes(16)).toString('base64') };
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
