import { describe, expect, it } from 'vitest';
import {
  createSeal,
  unlockSeal,
  unlockSealWithRecovery,
  rewrapSeal,
  sealSecrets,
  unsealSecrets,
  verifyDataKey,
  sealToInbox,
  openInbox,
  encodeRecoveryKey,
  decodeRecoveryKey,
  isSealRecord,
  parseTtl,
  clampUnlockTtlSeconds,
  WrongPassphraseError,
  randomBytes,
  UNLOCK_DEFAULT_TTL_SECONDS,
  UNLOCK_MAX_TTL_SECONDS,
} from './sealed-secrets.js';

const USER = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
// Low iterations would be rejected by policy, so tests pay for 600k once per seal.
const PASS = 'correct horse battery staple';

describe('sealed-secrets', () => {
  it('creates a seal, unlocks with the passphrase, and round-trips secrets', async () => {
    const { dek, seal, recoveryKey } = await createSeal(PASS, USER);
    expect(isSealRecord(seal)).toBe(true);
    expect(seal.kdf.iterations).toBeGreaterThanOrEqual(600_000);
    expect(recoveryKey).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{1,4})+$/);
    // nothing stored contains the DEK or passphrase
    expect(JSON.stringify(seal)).not.toContain(PASS);

    const blob = await sealSecrets(dek, { SOLANA_PRIVATE_KEY: 'abc', KRAKEN_API_SECRET: 'xyz' }, USER);
    const again = await unlockSeal(seal, PASS, USER);
    expect(Buffer.from(again).equals(Buffer.from(dek))).toBe(true);
    expect(await unsealSecrets(again, blob, USER)).toEqual({ SOLANA_PRIVATE_KEY: 'abc', KRAKEN_API_SECRET: 'xyz' });
    expect(await verifyDataKey(again, seal, USER)).toBe(true);
  }, 30_000);

  it('rejects a wrong passphrase, a wrong user (AAD) and a wrong key', async () => {
    const { dek, seal } = await createSeal(PASS, USER);
    await expect(unlockSeal(seal, 'not the passphrase!!', USER)).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(unlockSeal(seal, PASS, OTHER)).rejects.toBeInstanceOf(WrongPassphraseError);
    const blob = await sealSecrets(dek, { A: '1' }, USER);
    await expect(unsealSecrets(dek, blob, OTHER)).rejects.toBeDefined();
    await expect(unsealSecrets(randomBytes(32), blob, USER)).rejects.toBeDefined();
    expect(await verifyDataKey(randomBytes(32), seal, USER)).toBe(false);
    expect(await verifyDataKey(new Uint8Array(5), seal, USER)).toBe(false);
  }, 30_000);

  it('unlocks with the recovery key and keeps the DEK across a passphrase change', async () => {
    const { dek, seal, recoveryKey } = await createSeal(PASS, USER);
    const viaRecovery = await unlockSealWithRecovery(seal, recoveryKey.toLowerCase(), USER);
    expect(Buffer.from(viaRecovery).equals(Buffer.from(dek))).toBe(true);
    await expect(unlockSealWithRecovery(seal, encodeRecoveryKey(randomBytes(32)), USER)).rejects.toBeInstanceOf(WrongPassphraseError);

    const next = await rewrapSeal(dek, seal, 'a brand new passphrase', USER);
    expect(next.kdf.salt).not.toBe(seal.kdf.salt);
    expect(next.inbox_public_key).toBe(seal.inbox_public_key);
    await expect(unlockSeal(next, PASS, USER)).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(Buffer.from(await unlockSeal(next, 'a brand new passphrase', USER)).equals(Buffer.from(dek))).toBe(true);
    // recovery wrap survives the passphrase change
    expect(Buffer.from(await unlockSealWithRecovery(next, recoveryKey, USER)).equals(Buffer.from(dek))).toBe(true);
  }, 60_000);

  it('refuses short passphrases and weak kdf params', async () => {
    await expect(createSeal('short', USER)).rejects.toThrow(/at least/);
    const { seal } = await createSeal(PASS, USER);
    expect(isSealRecord({ ...seal, kdf: { ...seal.kdf, iterations: 1000 } })).toBe(false);
  }, 30_000);

  it('server can seal OAuth tokens to the inbox; only the DEK holder opens them', async () => {
    const { dek, seal } = await createSeal(PASS, USER);
    const e1 = await sealToInbox(seal.inbox_public_key, { ALPACA_OAUTH_TOKEN: 't1' }, USER);
    const e2 = await sealToInbox(seal.inbox_public_key, { ALPACA_OAUTH_TOKEN: 't2', ALPACA_OAUTH_REFRESH: 'r2' }, USER);
    e2.created_at = new Date(Date.parse(e1.created_at) + 1000).toISOString();
    expect(JSON.stringify(e1)).not.toContain('t1');
    const { patch, consumed } = await openInbox(dek, seal, [e2, e1], USER);
    expect(patch).toEqual({ ALPACA_OAUTH_TOKEN: 't2', ALPACA_OAUTH_REFRESH: 'r2' });
    expect(consumed.sort()).toEqual([e1.id, e2.id].sort());
    await expect(openInbox(randomBytes(32), seal, [e1], USER)).rejects.toBeDefined();
  }, 30_000);

  it('recovery key encoding round-trips', () => {
    const raw = randomBytes(32);
    expect(Buffer.from(decodeRecoveryKey(encodeRecoveryKey(raw))).equals(Buffer.from(raw))).toBe(true);
    expect(() => decodeRecoveryKey('ABCD')).toThrow();
  });

  it('ttl policy: default 8h, max 7d', () => {
    expect(parseTtl(undefined)).toBe(UNLOCK_DEFAULT_TTL_SECONDS);
    expect(parseTtl('30m')).toBe(1800);
    expect(parseTtl('30d')).toBe(UNLOCK_MAX_TTL_SECONDS);
    expect(clampUnlockTtlSeconds('nope')).toBe(UNLOCK_DEFAULT_TTL_SECONDS);
    expect(clampUnlockTtlSeconds(1)).toBe(60);
    expect(() => parseTtl('soon')).toThrow();
  });
});
