import type { NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { authRedirect, safeNextPath, siteOrigin } from '@/lib/auth-route-client';

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

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) return fail(error.message);
    return response;
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return fail(error.message);
    return response;
  }

  return fail('Missing confirmation token');
}
