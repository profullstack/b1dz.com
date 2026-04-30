/**
 * GET    /api/settings  → { plain, cipher: { ciphertext, iv, tag } | null,
 *                          lastUpdatedAt, cryptoConfigured }
 * PUT    /api/settings  → { plain?, cipher? }
 *
 * Server stores ciphertext only. The browser (and CLI) fetch the AES-256-GCM
 * key from /api/settings/crypto-key and encrypt/decrypt the secret blob
 * client-side. The server never holds plaintext secrets — it just passes
 * the cipher blob through to user_settings.
 *
 * For PUT:
 *   - If `cipher` is omitted, existing cipher columns are left untouched.
 *   - If `cipher` is null, cipher columns are cleared.
 *   - If `cipher` is { ciphertext, iv, tag }, those values overwrite.
 *   - `plain` is server-side merged (non-secret fields).
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { sanitizePlain, type PlainPayload } from '@/lib/settings-fields';

export const dynamic = 'force-dynamic';

interface SettingsRow {
  user_id: string;
  payload_plain: Record<string, unknown> | null;
  payload_secret_ciphertext: string | null;
  payload_secret_iv: string | null;
  payload_secret_tag: string | null;
  updated_at: string;
}

interface CipherBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

function secretCryptoConfigured(): boolean {
  return !!process.env.SETTINGS_ENCRYPTION_KEY;
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

function rowToCipher(row: SettingsRow | null): CipherBlob | null {
  if (!row?.payload_secret_ciphertext || !row.payload_secret_iv || !row.payload_secret_tag) return null;
  return {
    ciphertext: row.payload_secret_ciphertext,
    iv: row.payload_secret_iv,
    tag: row.payload_secret_tag,
  };
}

function isValidCipher(value: unknown): value is CipherBlob {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.ciphertext === 'string'
    && typeof v.iv === 'string'
    && typeof v.tag === 'string'
    && v.ciphertext.length > 0
    && v.iv.length > 0
    && v.tag.length > 0;
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  let row: SettingsRow | null;
  try {
    row = await loadSettingsRow(auth.client, auth.userId);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }

  return Response.json({
    plain: sanitizePlain(row?.payload_plain ?? {}),
    cipher: rowToCipher(row),
    lastUpdatedAt: row?.updated_at ?? null,
    cryptoConfigured: secretCryptoConfigured(),
  });
}

export async function PUT(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const raw = await req.json().catch(() => null) as { plain?: unknown; cipher?: unknown } | null;
  if (raw == null || typeof raw !== 'object') {
    return Response.json({ error: 'body required' }, { status: 400 });
  }

  const incomingPlain = sanitizePlain(raw.plain);
  const cipherProvided = 'cipher' in raw;
  const cipherIsNull = cipherProvided && raw.cipher === null;
  const cipherIsBlob = cipherProvided && raw.cipher !== null && isValidCipher(raw.cipher);

  if (cipherProvided && !cipherIsNull && !cipherIsBlob) {
    return Response.json(
      { error: 'cipher must be { ciphertext, iv, tag } (all base64 strings) or null' },
      { status: 400 },
    );
  }

  let existing: SettingsRow | null;
  try {
    existing = await loadSettingsRow(auth.client, auth.userId);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }

  // Merge plain (server-side merge of non-secret fields).
  const mergedPlain: PlainPayload = { ...(existing?.payload_plain ?? {}), ...incomingPlain };
  for (const [k, v] of Object.entries(mergedPlain)) {
    if (v === null) delete (mergedPlain as Record<string, unknown>)[k];
  }

  const row: Record<string, unknown> = {
    user_id: auth.userId,
    payload_plain: mergedPlain,
    updated_at: new Date().toISOString(),
  };

  if (cipherIsBlob) {
    const blob = raw.cipher as CipherBlob;
    row.payload_secret_ciphertext = blob.ciphertext;
    row.payload_secret_iv = blob.iv;
    row.payload_secret_tag = blob.tag;
  } else if (cipherIsNull) {
    row.payload_secret_ciphertext = null;
    row.payload_secret_iv = null;
    row.payload_secret_tag = null;
  } else {
    // cipher omitted → keep existing values
    row.payload_secret_ciphertext = existing?.payload_secret_ciphertext ?? null;
    row.payload_secret_iv = existing?.payload_secret_iv ?? null;
    row.payload_secret_tag = existing?.payload_secret_tag ?? null;
  }

  const upsert = (auth.client as unknown as {
    from: (t: string) => {
      upsert: (r: Record<string, unknown>, opts: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
    };
  }).from('user_settings').upsert(row, { onConflict: 'user_id' });
  const { error } = await upsert;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  console.log(`[api] settings updated user=${auth.userId.slice(0, 8)} plainKeys=${Object.keys(incomingPlain).length} cipher=${cipherIsBlob ? 'set' : cipherIsNull ? 'cleared' : 'unchanged'}`);

  return Response.json({
    plain: mergedPlain,
    cipher: cipherIsBlob
      ? raw.cipher as CipherBlob
      : cipherIsNull
        ? null
        : rowToCipher(existing),
    lastUpdatedAt: row.updated_at,
    cryptoConfigured: secretCryptoConfigured(),
  });
}
