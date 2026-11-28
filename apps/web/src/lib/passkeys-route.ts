import { NextResponse, type NextRequest } from 'next/server';
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase';
import { isPlaceholderEmail } from '@/lib/coinpay-signin';
import { CHALLENGE_COOKIE, CHALLENGE_COOKIE_PATH, CHALLENGE_TTL_SECONDS, rpConfig, sameOrigin, supabasePasskeyStore, type RpConfig } from '@/lib/passkeys';

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/** Same-origin check for every mutating passkey route; null when it passes. */
export function originGuard(req: NextRequest, cfg: RpConfig = rpConfig()): NextResponse | null {
  return sameOrigin(req.headers.get('origin'), cfg) ? null : json({ error: 'Cross-origin request refused.' }, 403);
}

export type SessionUser = { id: string; email: string | null; displayName: string };

/** Cookie session only: bearer and agent tokens cannot add or remove passkeys. */
export async function sessionUser(): Promise<SessionUser | null> {
  const sb = await createServerSupabase();
  const { data } = await sb.auth.getUser();
  const u = data.user;
  if (!u) return null;
  const email = u.email && !isPlaceholderEmail(u.email) ? u.email : null;
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
  const name = typeof meta.full_name === 'string' && meta.full_name.trim() ? meta.full_name.trim().slice(0, 64) : null;
  return { id: u.id, email, displayName: email ?? name ?? 'b1dz user' };
}

export const passkeyStore = () => supabasePasskeyStore(createAdminSupabase());

export function setChallengeCookie(res: NextResponse, id: string): NextResponse {
  res.cookies.set(CHALLENGE_COOKIE, id, {
    path: CHALLENGE_COOKIE_PATH,
    maxAge: CHALLENGE_TTL_SECONDS,
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
  });
  return res;
}

export function clearChallengeCookie(res: NextResponse): NextResponse {
  res.cookies.set(CHALLENGE_COOKIE, '', { path: CHALLENGE_COOKIE_PATH, maxAge: 0 });
  return res;
}

export const challengeId = (req: NextRequest) => req.cookies.get(CHALLENGE_COOKIE)?.value ?? null;
