import type { NextRequest } from 'next/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { REF_COOKIE } from '@profullstack/affiliates';
import { authJson, withAuthCookies } from '@/lib/auth-route-client';
import { afterSignIn, INVITE_COOKIE, trustedIp } from '@/lib/credits';
import { mintMagicLinkHash } from '@/lib/coinpay-signin';
import { createAdminSupabase } from '@/lib/supabase';
import { finishLogin, rpConfig } from '@/lib/passkeys';
import { challengeId, clearChallengeCookie, json, originGuard, passkeyStore } from '@/lib/passkeys-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/passkey/login/verify { response }
// Verifies the assertion (lib/passkeys.ts), then starts a normal Supabase
// session for the credential's owner by redeeming a server-minted magic-link
// hash for that user's own email (nothing is emailed), exactly as CoinPay
// sign-in does. Session tokens travel only as cookies.
export async function POST(req: NextRequest) {
  const cfg = rpConfig();
  const bad = originGuard(req, cfg);
  if (bad) return bad;
  const body = (await req.json().catch(() => null)) as { response?: AuthenticationResponseJSON } | null;
  if (!body?.response || typeof body.response !== 'object') return json({ error: 'response required' }, 400);

  const r = await finishLogin(cfg, { challengeId: challengeId(req), response: body.response }, passkeyStore());
  if (!r.ok) return clearChallengeCookie(json({ ok: false, error: r.error }, 401));

  const { response, supabase } = authJson(req, {});
  clearChallengeCookie(response);
  const { data: cur } = await supabase.auth.getUser();
  if (cur.user?.id !== r.userId) {
    if (cur.user) await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    const minted = await mintMagicLinkHash(createAdminSupabase(), r.userId);
    if (!minted.ok) return json({ ok: false, error: minted.error }, 401);
    const { error } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: minted.tokenHash });
    if (error) {
      console.error('[passkey] verifyOtp', error.message);
      return json({ ok: false, error: 'Could not start your session. Try again.' }, 500);
    }
  }

  await afterSignIn(r.userId, {
    cookieInvite: req.cookies.get(INVITE_COOKIE)?.value ?? null,
    ref: req.cookies.get(REF_COOKIE)?.value ?? null,
    ip: trustedIp(req.headers),
  });
  if (req.cookies.get(INVITE_COOKIE)) response.cookies.set(INVITE_COOKIE, '', { path: '/', maxAge: 0 });
  return withAuthCookies(response, { ok: true });
}
