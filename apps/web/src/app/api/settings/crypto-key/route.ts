/**
 * GET /api/settings/crypto-key
 *
 * Returns the base64-encoded per-user AES-256-GCM key that the browser,
 * CLI, and daemon use to encrypt/decrypt that user's secret blob. Auth
 * required. The key is derived from the server's master
 * SETTINGS_ENCRYPTION_KEY plus auth.userId.
 *
 * The browser holds this key in memory only (no localStorage). The
 * client-side settings path encrypts before PUT, and reveal happens locally.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { deriveUserSecretKey } from '@/lib/server-crypto';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  if (!process.env.SETTINGS_ENCRYPTION_KEY) {
    return Response.json(
      { error: 'SETTINGS_ENCRYPTION_KEY not configured on server' },
      {
        status: 503,
        headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
      },
    );
  }

  return Response.json(
    { key: deriveUserSecretKey(auth.userId).toString('base64') },
    { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
  );
}
