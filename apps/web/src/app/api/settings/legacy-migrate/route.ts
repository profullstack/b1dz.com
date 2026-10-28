/**
 * POST /api/settings/legacy-migrate
 *
 * One-shot migration of a seal_version 1 row (ciphertext under the old
 * server key). Returns the owner's legacy secrets, decrypted, to the owner's
 * own client exactly so it can re-seal them under the new passphrase and PUT
 * /api/settings { seal, cipher } (which overwrites the legacy ciphertext and
 * marks the row v2). Nothing is logged or stored here.
 *
 * Closed (410) when LEGACY_KEY_MIGRATION=off or SETTINGS_ENCRYPTION_KEY is
 * gone, and for rows already sealed under a passphrase (409).
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { decryptLegacySecret, legacyMigrationEnabled } from '@/lib/server-crypto';
import { loadSettingsRow, rowSeal, rowToCipher } from '@/lib/settings-row';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  if (!legacyMigrationEnabled()) {
    return Response.json({ error: 'legacy key migration is closed; re-enter your keys' }, { status: 410, headers: NO_STORE });
  }
  let row;
  try {
    row = await loadSettingsRow(auth.client, auth.userId);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500, headers: NO_STORE });
  }
  if (rowSeal(row)) return Response.json({ error: 'already sealed under your passphrase' }, { status: 409, headers: NO_STORE });
  const cipher = rowToCipher(row);
  if (!cipher) return Response.json({ secret: {} }, { headers: NO_STORE });
  try {
    const secret = decryptLegacySecret(cipher, auth.userId);
    console.log(`[api] legacy-migrate handed ${Object.keys(secret).length} legacy secret field(s) to owner ${auth.userId.slice(0, 8)}`);
    return Response.json({ secret }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: 'legacy secrets could not be decrypted; re-enter your keys' }, { status: 422, headers: NO_STORE });
  }
}
