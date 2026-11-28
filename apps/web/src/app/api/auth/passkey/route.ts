import type { NextRequest } from 'next/server';
import { cleanName, summarize } from '@/lib/passkeys';
import { json, originGuard, passkeyStore, sessionUser } from '@/lib/passkeys-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/auth/passkey: the signed-in user's passkeys (Settings).
export async function GET() {
  const user = await sessionUser();
  if (!user) return json({ error: 'Sign in first.' }, 401);
  const rows = await passkeyStore().byUser(user.id);
  return json({ passkeys: rows.map(summarize) });
}

// PATCH /api/auth/passkey { id, name }: rename.
export async function PATCH(req: NextRequest) {
  const bad = originGuard(req);
  if (bad) return bad;
  const user = await sessionUser();
  if (!user) return json({ error: 'Sign in first.' }, 401);
  const body = (await req.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
  if (typeof body?.id !== 'string') return json({ error: 'id required' }, 400);
  const ok = await passkeyStore().rename(user.id, body.id, cleanName(body.name));
  return ok ? json({ ok: true }) : json({ error: 'Passkey not found.' }, 404);
}

// DELETE /api/auth/passkey { id }: remove one of your own passkeys.
export async function DELETE(req: NextRequest) {
  const bad = originGuard(req);
  if (bad) return bad;
  const user = await sessionUser();
  if (!user) return json({ error: 'Sign in first.' }, 401);
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== 'string') return json({ error: 'id required' }, 400);
  const ok = await passkeyStore().remove(user.id, body.id);
  return ok ? json({ ok: true }) : json({ error: 'Passkey not found.' }, 404);
}
