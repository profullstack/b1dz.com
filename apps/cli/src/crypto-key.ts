/**
 * CLI-side crypto helpers — fetch the AES-256-GCM key from
 * /api/settings/crypto-key and encrypt/decrypt the secret blob locally.
 *
 * Wire format matches apps/daemon/src/user-config.ts and
 * apps/web/src/lib/browser-crypto.ts: base64 ciphertext + 12-byte IV +
 * 16-byte auth tag stored separately.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export interface CipherBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

export async function fetchCryptoKey(baseUrl: string, accessToken: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/settings/crypto-key`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 503) {
    throw new Error('SETTINGS_ENCRYPTION_KEY not configured on server');
  }
  if (!res.ok) {
    throw new Error(`crypto-key fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { key: string };
  return body.key;
}

export function encryptJson(keyB64: string, obj: unknown): CipherBlob {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error(`bad key length ${key.length}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptJson<T>(keyB64: string, blob: CipherBlob): T {
  const key = Buffer.from(keyB64, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ciphertext, 'base64');
  const dec = createDecipheriv(ALGO, key, iv);
  dec.setAuthTag(tag);
  const out = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  return JSON.parse(out) as T;
}
