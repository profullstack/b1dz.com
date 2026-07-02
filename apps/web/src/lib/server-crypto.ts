/**
 * Server-side AES-256-GCM for the user_settings secret blob.
 *
 * Normally secrets are encrypted in the browser (see lib/browser-crypto.ts) and
 * the server only stores ciphertext. The OAuth callback is the one server-side
 * writer: it receives tokens from the provider and must merge them into the
 * encrypted blob. The server holds SETTINGS_ENCRYPTION_KEY and derives a
 * per-user AES key from it, matching /api/settings/crypto-key.
 *
 * Format matches browser-crypto + the daemon's decryptBlob exactly:
 *   AES-256-GCM · 12-byte IV · 16-byte tag stored separately · all base64.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

export interface CipherBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

function masterKey(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) throw new Error('SETTINGS_ENCRYPTION_KEY not configured');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`SETTINGS_ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length})`);
  return buf;
}

export function deriveUserSecretKey(userId: string): Buffer {
  if (!userId) throw new Error('userId required');
  return createHmac('sha256', masterKey()).update(userId).digest();
}

export function encryptSecret(obj: Record<string, string>, userId: string): CipherBlob {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, deriveUserSecretKey(userId), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptWithKey(blob: CipherBlob, key: Buffer): Record<string, string> {
  const dec = createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'base64'));
  dec.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const out = Buffer.concat([dec.update(Buffer.from(blob.ciphertext, 'base64')), dec.final()]).toString('utf8');
  const parsed = JSON.parse(out) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') result[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') result[k] = String(v);
  }
  return result;
}

export function decryptCurrentUserSecret(blob: CipherBlob | null, userId: string): Record<string, string> {
  if (!blob?.ciphertext || !blob.iv || !blob.tag) return {};
  return decryptWithKey(blob, deriveUserSecretKey(userId));
}

export function decryptSecret(blob: CipherBlob | null, userId: string): Record<string, string> {
  if (!blob?.ciphertext || !blob.iv || !blob.tag) return {};
  try {
    return decryptCurrentUserSecret(blob, userId);
  } catch (e) {
    try {
      return decryptWithKey(blob, masterKey());
    } catch {
      throw e;
    }
  }
}

interface SettingsRowCrypto {
  payload_secret_ciphertext: string | null;
  payload_secret_iv: string | null;
  payload_secret_tag: string | null;
}

type SbClient = {
  from: (t: string) => {
    select: (s: string) => { eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: SettingsRowCrypto | null; error: { message: string } | null }> } };
    upsert: (r: Record<string, unknown>, o: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
  };
};

/**
 * Merge `patch` into the user's encrypted secret blob (decrypt → assign →
 * re-encrypt → upsert). Used by the OAuth callback to persist provider tokens
 * alongside any pasted credentials, without clobbering them.
 */
export async function mergeSecretIntoUserSettings(
  client: unknown,
  userId: string,
  patch: Record<string, string>,
): Promise<void> {
  const c = client as SbClient;
  const { data, error } = await c.from('user_settings').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  const existing = data?.payload_secret_ciphertext && data.payload_secret_iv && data.payload_secret_tag
    ? decryptSecret({ ciphertext: data.payload_secret_ciphertext, iv: data.payload_secret_iv, tag: data.payload_secret_tag }, userId)
    : {};
  const blob = encryptSecret({ ...existing, ...patch }, userId);
  const { error: upErr } = await c.from('user_settings').upsert(
    {
      user_id: userId,
      payload_secret_ciphertext: blob.ciphertext,
      payload_secret_iv: blob.iv,
      payload_secret_tag: blob.tag,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (upErr) throw new Error(upErr.message);
}
