/**
 * Trading session lock/unlock (browser + CLI).
 *
 *   GET    /api/daemon/session            -> { unlocked, expiresAt, reachable }
 *   POST   /api/daemon/session { dataKey, ttlSeconds? }  unlock (default 8h, max 7d)
 *   DELETE /api/daemon/session            lock now
 *
 * `dataKey` is the base64 32-byte data key the client unwrapped with the
 * user's passphrase (never the passphrase). It is forwarded to the daemon over
 * loopback and held there in memory only. The daemon verifies it against the
 * user's key-check value and rejects a wrong key.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { daemonLock, daemonStatus, daemonUnlock } from '@/lib/daemon-control';
import { clampUnlockTtlSeconds } from '@b1dz/core/sealed-secrets';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  return Response.json(await daemonStatus(auth.userId), { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const body = await req.json().catch(() => null) as { dataKey?: unknown; ttlSeconds?: unknown } | null;
  const dataKey = typeof body?.dataKey === 'string' ? body.dataKey : '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(dataKey)) {
    return Response.json({ error: 'dataKey must be a base64 32-byte key' }, { status: 400, headers: NO_STORE });
  }
  const ttlSeconds = clampUnlockTtlSeconds(body?.ttlSeconds);
  try {
    const r = await daemonUnlock(auth.userId, dataKey, ttlSeconds);
    if (!r.ok) {
      const msg = (r.body as { error?: string })?.error ?? `daemon refused (${r.status})`;
      return Response.json({ error: msg }, { status: r.status === 403 ? 403 : 502, headers: NO_STORE });
    }
    console.log(`[api] trading session unlocked user=${auth.userId.slice(0, 8)} ttl=${ttlSeconds}s`);
    return Response.json(r.body, { headers: NO_STORE });
  } catch {
    return Response.json({ error: 'trading daemon unreachable; try again shortly' }, { status: 503, headers: NO_STORE });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  try {
    const r = await daemonLock(auth.userId);
    console.log(`[api] trading session locked user=${auth.userId.slice(0, 8)}`);
    return Response.json(r.body, { status: r.ok ? 200 : 502, headers: NO_STORE });
  } catch {
    return Response.json({ error: 'trading daemon unreachable' }, { status: 503, headers: NO_STORE });
  }
}
