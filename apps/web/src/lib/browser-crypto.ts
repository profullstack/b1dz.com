/**
 * Browser-side AES-256-GCM helpers via Web Crypto API.
 *
 * Algorithm matches the daemon's apps/daemon/src/user-config.ts:
 *   - AES-256-GCM
 *   - 12-byte (96-bit) IV, fresh per encryption
 *   - 16-byte auth tag, stored separately from ciphertext (Node convention)
 *
 * Web Crypto natively concatenates ciphertext+tag in its output buffer; we
 * split the trailing 16 bytes into the `tag` field so the wire format
 * matches what Node's `aes-256-gcm` cipher emits via `getAuthTag()`.
 */

const ALGO = 'AES-GCM';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface CipherBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error(`encryption key must decode to 32 bytes (got ${raw.length})`);
  }
  return crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, { name: ALGO }, false, ['encrypt', 'decrypt']);
}

export async function encryptJson(key: CryptoKey, obj: unknown): Promise<CipherBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  // Web Crypto returns ciphertext || tag (last 16 bytes are the GCM tag).
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: ALGO, iv, tagLength: TAG_BYTES * 8 },
    key,
    plaintext,
  ));
  const ct = sealed.slice(0, sealed.length - TAG_BYTES);
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  return {
    ciphertext: bytesToBase64(ct),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(tag),
  };
}

export async function decryptJson<T>(key: CryptoKey, blob: CipherBlob): Promise<T> {
  const iv = base64ToBytes(blob.iv);
  const ct = base64ToBytes(blob.ciphertext);
  const tag = base64ToBytes(blob.tag);
  // Reassemble ciphertext || tag for Web Crypto.
  const sealed = new Uint8Array(ct.length + tag.length);
  sealed.set(ct, 0);
  sealed.set(tag, ct.length);
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGO, iv: iv as unknown as ArrayBuffer, tagLength: TAG_BYTES * 8 },
    key,
    sealed as unknown as ArrayBuffer,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
