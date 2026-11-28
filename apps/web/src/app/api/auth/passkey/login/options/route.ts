import type { NextRequest } from 'next/server';
import { rpConfig, startLogin } from '@/lib/passkeys';
import { json, originGuard, passkeyStore, setChallengeCookie } from '@/lib/passkeys-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/login/options: "Sign in with a passkey" on /login.
export async function POST(req: NextRequest) {
  const cfg = rpConfig();
  const bad = originGuard(req, cfg);
  if (bad) return bad;
  const r = await startLogin(cfg, passkeyStore());
  return setChallengeCookie(json({ options: r.options }), r.challengeId);
}
