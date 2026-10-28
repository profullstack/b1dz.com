/**
 * LEGACY ONLY: read seal_version 1 ciphertext for the one-shot migration.
 *
 * Before sealed keys, payload_secret_* was AES-256-GCM under
 * HMAC(SETTINGS_ENCRYPTION_KEY, user_id), or the master key itself for the
 * oldest rows. The server can no longer ENCRYPT anything with that key, and
 * nothing outside POST /api/settings/legacy-migrate may call this module.
 *
 * Cutoff: set LEGACY_KEY_MIGRATION=off to disable it entirely; then
 * SETTINGS_ENCRYPTION_KEY can be removed from env and vaults (Anthony's call).
 */
import { createDecipheriv, createHmac } from 'node:crypto';

const ALGO = 'aes-256-gcm';

export interface CipherBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** LEGACY_KEY_MIGRATION=off|false|0|disabled closes the migrate path. Default: open. */
export function legacyMigrationEnabled(): boolean {
  const v = (process.env.LEGACY_KEY_MIGRATION ?? 'on').trim().toLowerCase();
  if (['off', 'false', '0', 'no', 'disabled'].includes(v)) return false;
  return !!process.env.SETTINGS_ENCRYPTION_KEY;
}

function masterKey(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) throw new Error('legacy key not configured');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('legacy key has the wrong length');
  return buf;
}

function decryptWithKey(blob: CipherBlob, key: Buffer): Record<string, string> {
  const dec = createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'base64'));
  dec.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const out = Buffer.concat([dec.update(Buffer.from(blob.ciphertext, 'base64')), dec.final()]);
  try {
    const parsed = JSON.parse(out.toString('utf8')) as unknown;
    const result: Record<string, string> = {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') result[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') result[k] = String(v);
    }
    return result;
  } finally {
    out.fill(0);
  }
}

/**
 * Decrypt a legacy (seal_version 1) blob for its owner. Throws when the
 * migration switch is off. Callers must hand the result to the owner's
 * client once and never store or log it.
 */
export function decryptLegacySecret(blob: CipherBlob | null, userId: string): Record<string, string> {
  if (!legacyMigrationEnabled()) throw new Error('legacy key migration is closed');
  if (!blob?.ciphertext || !blob.iv || !blob.tag) return {};
  if (!userId) throw new Error('userId required');
  const master = masterKey();
  const perUser = createHmac('sha256', master).update(userId).digest();
  try {
    return decryptWithKey(blob, perUser);
  } catch (e) {
    try {
      return decryptWithKey(blob, master);
    } catch {
      throw e;
    }
  } finally {
    perUser.fill(0);
    master.fill(0);
  }
}
