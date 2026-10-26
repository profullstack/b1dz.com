import type { NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { authRedirect, safeNextPath, siteOrigin } from '@/lib/auth-route-client';
import { afterSignIn, INVITE_COOKIE, trustedIp } from '@/lib/credits';
import { REF_COOKIE } from '@profullstack/affiliates';

/**
 * Email-link landing route. Supports both Supabase confirmation styles:
 *
 *   1. token_hash + type  → verifyOtp  (recommended for SSR; NO PKCE code
 *      verifier, so it works even when the email is opened on a different
 *      device/browser — fixes "PKCE code verifier not found in storage").
 *   2. code               → exchangeCodeForSession (PKCE; needs the verifier
 *      cookie from the same browser that started the flow — kept as fallback).
 *
 * To get the cross-device path, set the Supabase email templates' confirmation
 * URL to:
 *   {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type={{ .Type }}&next=/dashboard
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const nextPath = safeNextPath(params.get('next'));
  const tokenHash = params.get('token_hash');
  const type = params.get('type') as EmailOtpType | null;
  const code = params.get('code');

  const fail = (msg: string) =>
    Response.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, siteOrigin(req)));

  const { response, supabase } = authRedirect(req, nextPath);

  // Invites and ?ref= attribution are settled on the first sign-in, when the
  // account is confirmed. afterSignIn never throws.
  const settle = async (userId: string | undefined) => {
    if (!userId) return response;
    await afterSignIn(userId, {
      cookieInvite: req.cookies.get(INVITE_COOKIE)?.value ?? null,
      ref: req.cookies.get(REF_COOKIE)?.value ?? null,
      ip: trustedIp(req.headers),
    });
    if (req.cookies.get(INVITE_COOKIE)) response.cookies.set(INVITE_COOKIE, '', { path: '/', maxAge: 0 });
    return response;
  };

  if (tokenHash && type) {
    const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) return fail(error.message);
    return settle(data?.user?.id);
  }

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return fail(error.message);
    return settle(data?.user?.id);
  }

  return fail('Missing confirmation token');
}
