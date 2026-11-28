import type { NextRequest } from 'next/server';
import { rpConfig, startRegistration } from '@/lib/passkeys';
import { json, originGuard, passkeyStore, sessionUser, setChallengeCookie } from '@/lib/passkeys-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/register/options: Settings -> Passkeys -> Add.
export async function POST(req: NextRequest) {
  const cfg = rpConfig();
  const bad = originGuard(req, cfg);
  if (bad) return bad;
  const user = await sessionUser();
  if (!user) return json({ error: 'Sign in first.' }, 401);
  const r = await startRegistration(cfg, user, passkeyStore());
  if (!r.ok) return json({ error: r.error }, 409);
  return setChallengeCookie(json({ options: r.options }), r.challengeId);
}
