/**
 * Cross-runtime crypto compatibility tests.
 *
 * The browser uses Web Crypto via apps/web/src/lib/browser-crypto.ts.
 * The daemon uses Node `crypto` via apps/daemon/src/user-config.ts.
 *
 * These must produce wire-compatible ciphertext so:
 *   - The daemon can decrypt what the browser encrypted (PUT path).
 *   - The browser can decrypt what was previously written by the
 *     server-side encrypt path or by the daemon if it ever did.
 *
 * Node 19+ exposes `globalThis.crypto.subtle` natively, so these tests
 * exercise the same Web Crypto API the browser uses against the same
 * Node `createDecipheriv` the daemon uses.
 */
import { describe, it, expect } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { importKey, encryptJson, decryptJson, type CipherBlob } from './browser-crypto';

const ALGO = 'aes-256-gcm';

function makeKey(): { keyB64: string; keyBuf: Buffer } {
  const buf = randomBytes(32);
  return { keyB64: buf.toString('base64'), keyBuf: buf };
}

function nodeEncrypt(plaintext: string, keyBuf: Buffer): CipherBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyBuf, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function nodeDecrypt(blob: CipherBlob, keyBuf: Buffer): string {
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ciphertext, 'base64');
  const dec = createDecipheriv(ALGO, keyBuf, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

describe('browser-crypto cross-runtime', () => {
  it('round-trips browser-encrypt → browser-decrypt', async () => {
    const { keyB64 } = makeKey();
    const key = await importKey(keyB64);
    const payload = { KRAKEN_API_KEY: 'abc', KRAKEN_API_SECRET: 'def==', EVM_PRIVATE_KEY: '0x' + 'a'.repeat(64) };
    const blob = await encryptJson(key, payload);
    const back = await decryptJson<typeof payload>(key, blob);
    expect(back).toEqual(payload);
  });

  it('browser-encrypted ciphertext decrypts in Node (matches daemon path)', async () => {
    const { keyB64, keyBuf } = makeKey();
    const key = await importKey(keyB64);
    const payload = { GEMINI_API_KEY: 'master-x', GEMINI_API_SECRET: 'longsecret', N: 42 };
    const blob = await encryptJson(key, payload);
    const decoded = nodeDecrypt(blob, keyBuf);
    expect(JSON.parse(decoded)).toEqual(payload);
  });

  it('Node-encrypted ciphertext decrypts in browser path', async () => {
    const { keyB64, keyBuf } = makeKey();
    const key = await importKey(keyB64);
    const payload = { COINBASE_API_KEY_NAME: 'organizations/.../apiKeys/...', SOLANA_PRIVATE_KEY: 'base58stuff' };
    const blob = nodeEncrypt(JSON.stringify(payload), keyBuf);
    const back = await decryptJson<typeof payload>(key, blob);
    expect(back).toEqual(payload);
  });

  it('rejects key with wrong byte length', async () => {
    const short = Buffer.alloc(16).toString('base64');
    await expect(importKey(short)).rejects.toThrow(/32 bytes/);
  });

  it('tampered ciphertext fails to decrypt (auth tag check)', async () => {
    const { keyB64 } = makeKey();
    const key = await importKey(keyB64);
    const blob = await encryptJson(key, { secret: 'value' });
    // Flip a byte in the ciphertext.
    const ct = Buffer.from(blob.ciphertext, 'base64');
    ct[0] = ct[0] ^ 0x01;
    const tampered = { ...blob, ciphertext: ct.toString('base64') };
    await expect(decryptJson(key, tampered)).rejects.toBeDefined();
  });
});
