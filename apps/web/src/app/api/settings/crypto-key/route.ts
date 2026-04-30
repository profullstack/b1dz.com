/**
 * GET /api/settings/crypto-key
 *
 * Returns the base64-encoded AES-256-GCM key that the browser, CLI, and
 * daemon all use to encrypt/decrypt the user_settings secret blob. Auth
 * required — the wire is HTTPS, the key is what the client already
 * implicitly trusts the server with for daemon-side decrypt anyway.
 *
 * The browser holds this key in memory only (no localStorage). The
 * server NEVER receives plaintext secrets — the client-side path
 * encrypts before PUT, and reveal happens locally.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const key = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!key) {
    return Response.json(
      { error: 'SETTINGS_ENCRYPTION_KEY not configured on server' },
      {
        status: 503,
        headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
      },
    );
  }

  return Response.json(
    { key },
    { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
  );
}
