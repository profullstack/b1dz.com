/**
 * AES-256-GCM symmetric crypto for the user_settings secret blob.
 *
 * The key is a single service-level env var (SETTINGS_ENCRYPTION_KEY),
 * base64-encoded 32 bytes. Each encryption call uses a fresh random
 * 12-byte IV and emits the auth tag separately so we can store all
 * three components as opaque base64 in their own columns.
 *
 * Lazy-init: the key is loaded on first use so importing this module
 * doesn't crash builds when the env var is unset (Phase A is shipping
 * before the Railway env is wired).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;
let cachedKeyError: string | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (cachedKeyError) throw new Error(cachedKeyError);
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) {
    cachedKeyError = 'SETTINGS_ENCRYPTION_KEY missing — cannot encrypt/decrypt user_settings secrets';
    throw new Error(cachedKeyError);
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    cachedKeyError = 'SETTINGS_ENCRYPTION_KEY is not valid base64';
    throw new Error(cachedKeyError);
  }
  if (buf.length !== KEY_BYTES) {
    cachedKeyError = `SETTINGS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`;
    throw new Error(cachedKeyError);
  }
  cachedKey = buf;
  return buf;
}

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encryptSecret(plaintext: string): EncryptedBlob {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSecret(blob: EncryptedBlob): string {
  const key = loadKey();
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ciphertext, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString('utf8');
}

export function secretCryptoConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}
