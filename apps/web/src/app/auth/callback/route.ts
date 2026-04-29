import type { NextRequest } from 'next/server';
import { authRedirect, safeNextPath, siteOrigin } from '@/lib/auth-route-client';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const nextPath = safeNextPath(req.nextUrl.searchParams.get('next'));

  if (!code) {
    return Response.redirect(new URL(`/login?error=${encodeURIComponent('Missing auth code')}`, siteOrigin(req)));
  }

  const { response, supabase } = authRedirect(req, nextPath);
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return Response.redirect(new URL(`/login?error=${encodeURIComponent(error.message)}`, siteOrigin(req)));
  }

  return response;
}
