/**
 * GET /api/settings -> {
 *   userId, plain, cipher, seal, sealVersion, inbox, legacy, lastUpdatedAt, cryptoConfigured
 * }
 * PUT /api/settings <- { plain?, cipher?, seal?, inboxConsumed? }
 *
 * Secrets are sealed by the client under a key derived from the user's
 * passphrase (see @b1dz/core/sealed-secrets). The server stores ciphertext,
 * the seal record (salt, KDF params, wrapped keys) and nothing that opens
 * them. There is no server key for v2 rows.
 *
 * PUT rules:
 *   - `cipher` omitted: leave the ciphertext alone. `null`: clear it.
 *     A blob: only accepted for a sealed (v2) row, or together with `seal`
 *     (first setup / legacy migration), and marks the row seal_version 2.
 *   - `seal`: the v2 seal record (first setup, migration, or passphrase
 *     change). A legacy row moving to v2 must send `cipher` in the same
 *     request so the old server-key ciphertext is overwritten, not relabelled.
 *   - `inboxConsumed`: ids of OAuth inbox entries the client merged.
 *   - `plain` is merged server-side (non-secret fields).
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { legacyMigrationEnabled } from '@/lib/server-crypto';
import { sanitizePlain, type PlainPayload } from '@/lib/settings-fields';
import { isCipherBlob, isSealRecord, type CipherBlob, type SealRecord } from '@b1dz/core/sealed-secrets';
import { loadSettingsRow, rowInbox, rowSeal, rowToCipher, type SettingsRow, type Sb } from '@/lib/settings-row';

export const dynamic = 'force-dynamic';

function describe(row: SettingsRow | null, userId: string) {
  const seal = rowSeal(row);
  const legacyPending = !seal && !!rowToCipher(row);
  return {
    userId,
    plain: sanitizePlain(row?.payload_plain ?? {}),
    // Legacy ciphertext is never handed out here; it only leaves through the
    // one-shot migrate endpoint, decrypted for its owner.
    cipher: seal ? rowToCipher(row) : null,
    seal,
    sealVersion: seal ? 2 : 1,
    inbox: seal ? rowInbox(row) : [],
    legacy: { pending: legacyPending, migrationOpen: legacyPending && legacyMigrationEnabled() },
    lastUpdatedAt: row?.updated_at ?? null,
    cryptoConfigured: true,
  };
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  try {
    const row = await loadSettingsRow(auth.client, auth.userId);
    return Response.json(describe(row, auth.userId), { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const raw = await req.json().catch(() => null) as { plain?: unknown; cipher?: unknown; seal?: unknown; inboxConsumed?: unknown } | null;
  if (raw == null || typeof raw !== 'object') return Response.json({ error: 'body required' }, { status: 400 });

  const incomingPlain = sanitizePlain(raw.plain);
  const cipherProvided = 'cipher' in raw;
  const cipherIsNull = cipherProvided && raw.cipher === null;
  const cipherIsBlob = cipherProvided && isCipherBlob(raw.cipher);
  if (cipherProvided && !cipherIsNull && !cipherIsBlob) {
    return Response.json({ error: 'cipher must be { ciphertext, iv, tag } (all base64 strings) or null' }, { status: 400 });
  }
  const sealProvided = 'seal' in raw && raw.seal !== undefined;
  if (sealProvided && !isSealRecord(raw.seal)) {
    return Response.json({ error: 'seal must be a v2 seal record (PBKDF2-SHA256 >= 600k iterations)' }, { status: 400 });
  }
  const consumed = Array.isArray(raw.inboxConsumed) ? raw.inboxConsumed.filter((x): x is string => typeof x === 'string') : [];

  let existing: SettingsRow | null;
  try {
    existing = await loadSettingsRow(auth.client, auth.userId);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
  const existingSeal = rowSeal(existing);
  const legacyCipher = !existingSeal && !!rowToCipher(existing);

  if (cipherIsBlob && !existingSeal && !sealProvided) {
    return Response.json({ error: 'set a passphrase first: secrets are sealed under your passphrase' }, { status: 409 });
  }
  if (sealProvided && legacyCipher && !cipherProvided) {
    return Response.json({ error: 'migrating legacy secrets: send the re-sealed cipher (or null) with the seal' }, { status: 409 });
  }

  const mergedPlain: PlainPayload = { ...(existing?.payload_plain ?? {}), ...incomingPlain };
  for (const [k, v] of Object.entries(mergedPlain)) {
    if (v === null) delete (mergedPlain as Record<string, unknown>)[k];
  }

  const row: Record<string, unknown> = {
    user_id: auth.userId,
    payload_plain: mergedPlain,
    updated_at: new Date().toISOString(),
  };

  const nextSeal = sealProvided ? (raw.seal as SealRecord) : existingSeal;
  if (nextSeal) {
    row.seal = nextSeal;
    row.seal_version = 2;
  }

  if (cipherIsBlob) {
    const blob = raw.cipher as CipherBlob;
    row.payload_secret_ciphertext = blob.ciphertext;
    row.payload_secret_iv = blob.iv;
    row.payload_secret_tag = blob.tag;
  } else if (cipherIsNull) {
    row.payload_secret_ciphertext = null;
    row.payload_secret_iv = null;
    row.payload_secret_tag = null;
  }

  if (nextSeal) {
    const inbox = sealProvided && !existingSeal ? [] : rowInbox(existing).filter((e) => !consumed.includes(e.id));
    row.secret_inbox = inbox;
  }

  const { error } = await (auth.client as unknown as Sb).from('user_settings').upsert(row, { onConflict: 'user_id' });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  console.log(`[api] settings updated user=${auth.userId.slice(0, 8)} plainKeys=${Object.keys(incomingPlain).length} cipher=${cipherIsBlob ? 'set' : cipherIsNull ? 'cleared' : 'unchanged'} seal=${sealProvided ? (existingSeal ? 'rewrapped' : 'created') : 'unchanged'} inboxConsumed=${consumed.length}`);

  try {
    return Response.json(describe(await loadSettingsRow(auth.client, auth.userId), auth.userId));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
