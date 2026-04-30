/**
 * GET    /api/settings           → plain + masked secret status (set/unset + length)
 * PUT    /api/settings           → merge { plain?, secret? }; null deletes a key
 *
 * Secrets are NEVER returned in plaintext over the wire. The web UI shows
 * masked indicators only. The TUI and daemon decrypt locally using the
 * shared SETTINGS_ENCRYPTION_KEY (env-supplied to those processes).
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { decryptSecret, encryptSecret, secretCryptoConfigured } from '@/lib/secret-crypto';
import {
  maskSecrets,
  sanitizePlain,
  sanitizeSecret,
  type PlainPayload,
  type SecretPayload,
} from '@/lib/settings-fields';

export const dynamic = 'force-dynamic';

interface SettingsRow {
  user_id: string;
  payload_plain: Record<string, unknown> | null;
  payload_secret_ciphertext: string | null;
  payload_secret_iv: string | null;
  payload_secret_tag: string | null;
  updated_at: string;
}

async function loadSettingsRow(client: ReturnType<typeof Object>, userId: string): Promise<SettingsRow | null> {
  const c = client as unknown as {
    from: (t: string) => { select: (s: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => Promise<{ data: SettingsRow | null; error: { message: string } | null }>;
      };
    } };
  };
  const { data, error } = await c.from('user_settings').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function decryptOrEmpty(row: SettingsRow | null): SecretPayload {
  if (!row?.payload_secret_ciphertext || !row.payload_secret_iv || !row.payload_secret_tag) return {};
  try {
    const json = decryptSecret({
      ciphertext: row.payload_secret_ciphertext,
      iv: row.payload_secret_iv,
      tag: row.payload_secret_tag,
    });
    const parsed = JSON.parse(json) as unknown;
    return sanitizeSecret(parsed);
  } catch {
    // If the key was rotated or the row is corrupt, surface as "no secrets set"
    // rather than 500. The owner can re-enter values from the UI.
    return {};
  }
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const cryptoOk = secretCryptoConfigured();

  let row: SettingsRow | null;
  try {
    row = await loadSettingsRow(auth.client, auth.userId);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }

  const plain = sanitizePlain(row?.payload_plain ?? {});
  // Decrypt only to mask — plaintext never leaves this function.
  const secret: SecretPayload = cryptoOk ? decryptOrEmpty(row) : {};

  return Response.json({
    plain,
    secret: maskSecrets(secret),
    lastUpdatedAt: row?.updated_at ?? null,
    cryptoConfigured: cryptoOk,
  });
}

export async function PUT(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const raw = await req.json().catch(() => null) as { plain?: unknown; secret?: unknown } | null;
  if (raw == null || typeof raw !== 'object') {
    return Response.json({ error: 'body required' }, { status: 400 });
  }

  const incomingPlain = sanitizePlain(raw.plain);
  const incomingSecret = sanitizeSecret(raw.secret);
  const willTouchSecret = Object.keys(incomingSecret).length > 0;

  if (willTouchSecret && !secretCryptoConfigured()) {
    return Response.json(
      { error: 'SETTINGS_ENCRYPTION_KEY not configured on server; cannot save secrets' },
      { status: 503 },
    );
  }

  let existing: SettingsRow | null;
  try {
    existing = await loadSettingsRow(auth.client, auth.userId);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }

  // Merge plain
  const mergedPlain: PlainPayload = { ...(existing?.payload_plain ?? {}), ...incomingPlain };
  // Drop nulled-out plain keys so the JSON stays tidy
  for (const [k, v] of Object.entries(mergedPlain)) {
    if (v === null) delete (mergedPlain as Record<string, unknown>)[k];
  }

  // Merge secret
  let mergedSecret: SecretPayload = secretCryptoConfigured() ? decryptOrEmpty(existing) : {};
  for (const [k, v] of Object.entries(incomingSecret)) {
    if (v === null) delete (mergedSecret as Record<string, string>)[k];
    else (mergedSecret as Record<string, string>)[k] = v;
  }

  const row: Record<string, unknown> = {
    user_id: auth.userId,
    payload_plain: mergedPlain,
    updated_at: new Date().toISOString(),
  };

  if (Object.keys(mergedSecret).length > 0 && secretCryptoConfigured()) {
    const blob = encryptSecret(JSON.stringify(mergedSecret));
    row.payload_secret_ciphertext = blob.ciphertext;
    row.payload_secret_iv = blob.iv;
    row.payload_secret_tag = blob.tag;
  } else {
    // Either user cleared all secrets, or crypto is unavailable and we have
    // none to begin with. Either way, null out the cipher columns.
    row.payload_secret_ciphertext = null;
    row.payload_secret_iv = null;
    row.payload_secret_tag = null;
    mergedSecret = {};
  }

  const upsert = (auth.client as unknown as {
    from: (t: string) => {
      upsert: (r: Record<string, unknown>, opts: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
    };
  }).from('user_settings').upsert(row, { onConflict: 'user_id' });
  const { error } = await upsert;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  console.log(`[api] settings updated user=${auth.userId.slice(0, 8)} plainKeys=${Object.keys(incomingPlain).length} secretTouched=${Object.keys(incomingSecret).length}`);

  return Response.json({
    plain: mergedPlain,
    secret: maskSecrets(mergedSecret),
    lastUpdatedAt: row.updated_at,
    cryptoConfigured: secretCryptoConfigured(),
  });
}
