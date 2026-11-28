import type { NextRequest } from 'next/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { finishRegistration, rpConfig } from '@/lib/passkeys';
import { challengeId, clearChallengeCookie, json, originGuard, passkeyStore, sessionUser } from '@/lib/passkeys-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/register/verify { response, name? }
export async function POST(req: NextRequest) {
  const cfg = rpConfig();
  const bad = originGuard(req, cfg);
  if (bad) return bad;
  const user = await sessionUser();
  if (!user) return json({ error: 'Sign in first.' }, 401);
  const body = (await req.json().catch(() => null)) as { response?: RegistrationResponseJSON; name?: unknown } | null;
  if (!body?.response || typeof body.response !== 'object') return json({ error: 'response required' }, 400);
  const r = await finishRegistration(cfg, { userId: user.id, challengeId: challengeId(req), response: body.response, name: body.name }, passkeyStore());
  return clearChallengeCookie(r.ok ? json({ ok: true, passkey: r.passkey }) : json({ ok: false, error: r.error }, 400));
}
