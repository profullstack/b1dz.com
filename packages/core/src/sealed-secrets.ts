/**
 * User-held sealing for user_settings secrets (seal_version 2).
 *
 * Isomorphic: WebCrypto only (browser, Node >= 22 CLI, daemon). No server
 * key can open anything in here; every key comes from the user.
 *
 *   passphrase --PBKDF2-SHA256 600k, 16-byte salt--> ikm
 *   ikm --HKDF-SHA256 (info "b1dz/kek/v2")--> KEK (AES-256-GCM)
 *   KEK wraps a random 32-byte data key (DEK)          -> seal.wrapped_dek
 *   recovery key --HKDF--> RKEK wraps the same DEK      -> seal.recovery_wrapped_dek
 *   DEK seals the secret blob (AAD: user id + field)    -> payload_secret_*
 *   DEK seals a fixed string                            -> seal.key_check
 *
 * The DEK is what a client sends to the daemon to unlock a trading session.
 * The passphrase never leaves the client.
 *
 * OAuth inbox: the browser also creates an ECDH P-256 key pair. The public
 * half is stored in the clear (seal.inbox_public_key); the private half is
 * sealed under the DEK. The server-side OAuth callback seals provider tokens
 * to the public key (sealToInbox) and queues them in user_settings.secret_inbox;
 * an unlocked client (browser or daemon) opens them and merges them into the
 * blob. So the server can write a secret it can never read back.
 *
 * Wire format of a CipherBlob is unchanged from v1: base64 ciphertext,
 * 12-byte IV and the 16-byte GCM tag stored separately.
 */

export const SEAL_VERSION = 2;
export const LEGACY_SEAL_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 10;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_CHECK_TEXT = 'b1dz-key-check-v2';
export const SECRET_FIELD = 'payload_secret';
const INBOX_PRIVATE_FIELD = 'inbox_private_key';

export interface CipherBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface SealKdf {
  alg: 'PBKDF2-SHA256';
  iterations: number;
  /** base64, 16 random bytes */
  salt: string;
}

/** Stored in user_settings.seal (jsonb). Nothing in here opens without the passphrase or recovery key. */
export interface SealRecord {
  v: 2;
  kdf: SealKdf;
  wrapped_dek: CipherBlob;
  recovery_wrapped_dek: CipherBlob | null;
  key_check: CipherBlob;
  /** base64 raw (uncompressed) P-256 public key for the OAuth inbox */
  inbox_public_key: string;
  /** pkcs8 private key, sealed under the DEK */
  inbox_private_sealed: CipherBlob;
}

/** One provider token patch sealed to the user's inbox public key. */
export interface InboxEntry {
  id: string;
  /** base64 raw ephemeral P-256 public key */
  epk: string;
  blob: CipherBlob;
  created_at: string;
}

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('WebCrypto (crypto.subtle) is not available');
  return c.subtle;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

type Bytes = Uint8Array<ArrayBuffer>;

function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string): Bytes {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Best-effort wipe of a key buffer once it is no longer needed. */
export function wipe(bytes: Uint8Array | null | undefined): void {
  if (bytes) bytes.fill(0);
}

function aad(userId: string, field: string): Bytes {
  if (!userId) throw new Error('userId required for AAD');
  return enc.encode(`b1dz:user_settings:${userId}:${field}`);
}

async function gcmEncrypt(key: CryptoKey, plaintext: Uint8Array, ad: Uint8Array): Promise<CipherBlob> {
  const iv = randomBytes(IV_BYTES);
  const sealed = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: buf(ad), tagLength: TAG_BYTES * 8 },
    key,
    buf(plaintext),
  ));
  return {
    ciphertext: bytesToBase64(sealed.slice(0, sealed.length - TAG_BYTES)),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(sealed.slice(sealed.length - TAG_BYTES)),
  };
}

async function gcmDecrypt(key: CryptoKey, blob: CipherBlob, ad: Uint8Array): Promise<Bytes> {
  const ct = base64ToBytes(blob.ciphertext);
  const tag = base64ToBytes(blob.tag);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct, 0);
  joined.set(tag, ct.length);
  const out = await subtle().decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(blob.iv), additionalData: buf(ad), tagLength: TAG_BYTES * 8 },
    key,
    buf(joined),
  );
  return new Uint8Array(out);
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error(`data key must be 32 bytes (got ${raw.length})`);
  return subtle().importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function hkdfAesKey(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', buf(ikm), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(enc.encode(info)) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Passphrase -> KEK. PBKDF2-SHA256 (>= 600k) then HKDF, matching OpenCreds. */
export async function deriveKek(passphrase: string, kdf: SealKdf): Promise<CryptoKey> {
  if (kdf.alg !== 'PBKDF2-SHA256') throw new Error(`unsupported kdf ${kdf.alg}`);
  if (kdf.iterations < MIN_PBKDF2_ITERATIONS) throw new Error('kdf iterations below policy');
  const salt = base64ToBytes(kdf.salt);
  const pw = await subtle().importKey('raw', buf(enc.encode(passphrase.normalize('NFKC'))), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations: kdf.iterations },
    pw,
    256,
  ));
  try {
    return await hkdfAesKey(bits, salt, 'b1dz/kek/v2');
  } finally {
    wipe(bits);
  }
}

/** Recovery key (high entropy, shown once) -> KEK. No stretching needed. */
async function deriveRecoveryKek(recoveryKey: string): Promise<CryptoKey> {
  const raw = decodeRecoveryKey(recoveryKey);
  try {
    return await hkdfAesKey(raw, enc.encode('b1dz/recovery'), 'b1dz/recovery-kek/v2');
  } finally {
    wipe(raw);
  }
}

const B32 = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'; // Crockford-ish, no I L O U

/** 32 random bytes as grouped base32 text, e.g. ABCD-EFGH-... (52 chars). */
export function encodeRecoveryKey(raw: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of raw) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join('-');
}

export function decodeRecoveryKey(text: string): Bytes {
  const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid recovery key');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length < 32) throw new Error('invalid recovery key');
  return new Uint8Array(out.slice(0, 32));
}

export async function sealJson(dek: Uint8Array, obj: unknown, userId: string, field = SECRET_FIELD): Promise<CipherBlob> {
  return gcmEncrypt(await aesKey(dek), enc.encode(JSON.stringify(obj)), aad(userId, field));
}

export async function unsealJson<T>(dek: Uint8Array, blob: CipherBlob, userId: string, field = SECRET_FIELD): Promise<T> {
  const out = await gcmDecrypt(await aesKey(dek), blob, aad(userId, field));
  try {
    return JSON.parse(dec.decode(out)) as T;
  } finally {
    wipe(out);
  }
}

/** Normalise a decrypted secret map to string values only. */
export function toSecretMap(parsed: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') result[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') result[k] = String(v);
  }
  return result;
}

export async function sealSecrets(dek: Uint8Array, secrets: Record<string, string>, userId: string): Promise<CipherBlob> {
  return sealJson(dek, secrets, userId, SECRET_FIELD);
}

export async function unsealSecrets(dek: Uint8Array, blob: CipherBlob, userId: string): Promise<Record<string, string>> {
  return toSecretMap(await unsealJson<unknown>(dek, blob, userId, SECRET_FIELD));
}

export interface CreatedSeal {
  dek: Bytes;
  seal: SealRecord;
  /** Show to the user exactly once; never stored. */
  recoveryKey: string;
}

/** First-time setup: new DEK, wrapped under the passphrase and a recovery key. */
export async function createSeal(passphrase: string, userId: string, iterations = PBKDF2_ITERATIONS): Promise<CreatedSeal> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const dek = randomBytes(32);
  const recoveryRaw = randomBytes(32);
  const recoveryKey = encodeRecoveryKey(recoveryRaw);
  wipe(recoveryRaw);
  const seal = await buildSeal(dek, passphrase, recoveryKey, userId, iterations);
  return { dek, seal, recoveryKey };
}

async function buildSeal(
  dek: Uint8Array,
  passphrase: string,
  recoveryKey: string | null,
  userId: string,
  iterations: number,
  keepInbox?: Pick<SealRecord, 'inbox_public_key' | 'inbox_private_sealed'>,
  keepRecovery?: CipherBlob | null,
): Promise<SealRecord> {
  const kdf: SealKdf = { alg: 'PBKDF2-SHA256', iterations, salt: bytesToBase64(randomBytes(16)) };
  const kek = await deriveKek(passphrase, kdf);
  const wrapped_dek = await gcmEncrypt(kek, dek, aad(userId, 'dek:passphrase'));
  let recovery_wrapped_dek: CipherBlob | null = keepRecovery ?? null;
  if (recoveryKey) {
    const rkek = await deriveRecoveryKek(recoveryKey);
    recovery_wrapped_dek = await gcmEncrypt(rkek, dek, aad(userId, 'dek:recovery'));
  }
  const key_check = await sealJson(dek, KEY_CHECK_TEXT, userId, 'key_check');
  let inbox = keepInbox;
  if (!inbox) {
    const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as { publicKey: CryptoKey; privateKey: CryptoKey };
    const pub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
    const priv = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
    const inbox_private_sealed = await gcmEncrypt(await aesKey(dek), priv, aad(userId, INBOX_PRIVATE_FIELD));
    wipe(priv);
    inbox = { inbox_public_key: bytesToBase64(pub), inbox_private_sealed };
  }
  return { v: 2, kdf, wrapped_dek, recovery_wrapped_dek, key_check, ...inbox };
}

/** Change passphrase: same DEK (so ciphertext stays valid), new salt and wrap. */
export async function rewrapSeal(dek: Uint8Array, seal: SealRecord, newPassphrase: string, userId: string): Promise<SealRecord> {
  if (newPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  await assertKeyCheck(dek, seal, userId);
  return buildSeal(dek, newPassphrase, null, userId, Math.max(seal.kdf.iterations, PBKDF2_ITERATIONS),
    { inbox_public_key: seal.inbox_public_key, inbox_private_sealed: seal.inbox_private_sealed },
    seal.recovery_wrapped_dek);
}

export class WrongPassphraseError extends Error {
  constructor(msg = 'wrong passphrase') { super(msg); this.name = 'WrongPassphraseError'; }
}

/** Passphrase -> DEK. Throws WrongPassphraseError on a bad passphrase. */
export async function unlockSeal(seal: SealRecord, passphrase: string, userId: string): Promise<Bytes> {
  const kek = await deriveKek(passphrase, seal.kdf);
  let dek: Bytes;
  try {
    dek = await gcmDecrypt(kek, seal.wrapped_dek, aad(userId, 'dek:passphrase'));
  } catch {
    throw new WrongPassphraseError();
  }
  await assertKeyCheck(dek, seal, userId);
  return dek;
}

export async function unlockSealWithRecovery(seal: SealRecord, recoveryKey: string, userId: string): Promise<Bytes> {
  if (!seal.recovery_wrapped_dek) throw new WrongPassphraseError('no recovery key on file');
  let dek: Bytes;
  try {
    const rkek = await deriveRecoveryKek(recoveryKey);
    dek = await gcmDecrypt(rkek, seal.recovery_wrapped_dek, aad(userId, 'dek:recovery'));
  } catch {
    throw new WrongPassphraseError('wrong recovery key');
  }
  await assertKeyCheck(dek, seal, userId);
  return dek;
}

/** True when `dek` is this user's data key (used by the daemon unlock endpoint). */
export async function verifyDataKey(dek: Uint8Array, seal: Pick<SealRecord, 'key_check'>, userId: string): Promise<boolean> {
  if (dek.length !== 32) return false;
  try {
    return (await unsealJson<string>(dek, seal.key_check, userId, 'key_check')) === KEY_CHECK_TEXT;
  } catch {
    return false;
  }
}

async function assertKeyCheck(dek: Uint8Array, seal: Pick<SealRecord, 'key_check'>, userId: string): Promise<void> {
  if (!(await verifyDataKey(dek, seal, userId))) throw new WrongPassphraseError('key check failed');
}

export function isSealRecord(v: unknown): v is SealRecord {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  const kdf = s.kdf as Record<string, unknown> | undefined;
  return s.v === 2
    && !!kdf && kdf.alg === 'PBKDF2-SHA256' && typeof kdf.iterations === 'number' && kdf.iterations >= MIN_PBKDF2_ITERATIONS
    && typeof kdf.salt === 'string'
    && isCipherBlob(s.wrapped_dek) && isCipherBlob(s.key_check) && isCipherBlob(s.inbox_private_sealed)
    && (s.recovery_wrapped_dek === null || isCipherBlob(s.recovery_wrapped_dek))
    && typeof s.inbox_public_key === 'string';
}

export function isCipherBlob(v: unknown): v is CipherBlob {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return typeof b.ciphertext === 'string' && typeof b.iv === 'string' && typeof b.tag === 'string'
    && b.ciphertext.length > 0 && b.iv.length > 0 && b.tag.length > 0;
}

// ---------------------------------------------------------------- inbox ---

async function inboxKey(shared: Uint8Array, epk: Uint8Array, userId: string): Promise<CryptoKey> {
  return hkdfAesKey(shared, epk, `b1dz/inbox/v2/${userId}`);
}

/** Server side (OAuth callback): seal a patch to the user's inbox public key. */
export async function sealToInbox(publicKeyB64: string, patch: Record<string, string>, userId: string): Promise<InboxEntry> {
  const recipient = await subtle().importKey('raw', buf(base64ToBytes(publicKeyB64)), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256));
  const epk = new Uint8Array(await subtle().exportKey('raw', eph.publicKey));
  try {
    const key = await inboxKey(shared, epk, userId);
    const blob = await gcmEncrypt(key, enc.encode(JSON.stringify(patch)), aad(userId, 'inbox'));
    return { id: bytesToBase64(randomBytes(9)).replace(/[+/=]/g, ''), epk: bytesToBase64(epk), blob, created_at: new Date().toISOString() };
  } finally {
    wipe(shared);
  }
}

/** Unlocked client: open queued inbox entries. Returns the merged patch and the ids consumed. */
export async function openInbox(
  dek: Uint8Array,
  seal: Pick<SealRecord, 'inbox_private_sealed'>,
  entries: InboxEntry[],
  userId: string,
): Promise<{ patch: Record<string, string>; consumed: string[] }> {
  const patch: Record<string, string> = {};
  const consumed: string[] = [];
  if (!entries.length) return { patch, consumed };
  const pkcs8 = await gcmDecrypt(await aesKey(dek), seal.inbox_private_sealed, aad(userId, INBOX_PRIVATE_FIELD));
  let priv: CryptoKey;
  try {
    priv = await subtle().importKey('pkcs8', buf(pkcs8), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } finally {
    wipe(pkcs8);
  }
  const sorted = [...entries].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const e of sorted) {
    try {
      const epk = base64ToBytes(e.epk);
      const pub = await subtle().importKey('raw', buf(epk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, priv, 256));
      const key = await inboxKey(shared, epk, userId);
      wipe(shared);
      const out = await gcmDecrypt(key, e.blob, aad(userId, 'inbox'));
      Object.assign(patch, toSecretMap(JSON.parse(dec.decode(out))));
      wipe(out);
      consumed.push(e.id);
    } catch {
      // Leave an unreadable entry in place; it is reported, not dropped.
    }
  }
  return { patch, consumed };
}

export function isInboxEntry(v: unknown): v is InboxEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.epk === 'string' && typeof e.created_at === 'string' && isCipherBlob(e.blob);
}

// ----------------------------------------------------- unlock TTL policy ---

export const UNLOCK_DEFAULT_TTL_SECONDS = 8 * 3600;
export const UNLOCK_MAX_TTL_SECONDS = 7 * 24 * 3600;
export const UNLOCK_MIN_TTL_SECONDS = 60;

export function clampUnlockTtlSeconds(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return UNLOCK_DEFAULT_TTL_SECONDS;
  return Math.min(UNLOCK_MAX_TTL_SECONDS, Math.max(UNLOCK_MIN_TTL_SECONDS, Math.floor(n)));
}

/** "8h", "30m", "7d", "3600" -> seconds (clamped). */
export function parseTtl(text: string | undefined): number {
  if (!text) return UNLOCK_DEFAULT_TTL_SECONDS;
  const m = /^(\d+)\s*([smhd]?)$/i.exec(text.trim());
  if (!m) throw new Error(`bad ttl "${text}" (use e.g. 30m, 8h, 7d)`);
  const mult = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as '' | 's' | 'm' | 'h' | 'd'];
  return clampUnlockTtlSeconds(Number(m[1]) * mult);
}
