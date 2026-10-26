import type { NextRequest } from 'next/server';
import { authJson, withAuthCookies } from '@/lib/auth-route-client';
import { afterSignIn, INVITE_COOKIE, trustedIp } from '@/lib/credits';
import { REF_COOKIE } from '@profullstack/affiliates';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { email?: string; password?: string } | null;
  if (!body?.email || !body?.password) return Response.json({ error: 'email + password required' }, { status: 400 });

  const { response, supabase } = authJson(req, {});
  const { data, error } = await supabase.auth.signInWithPassword({
    email: body.email.trim(),
    password: body.password,
  });

  if (error || !data.user || !data.session) {
    return Response.json({ error: error?.message ?? 'login failed' }, { status: 401 });
  }

  await afterSignIn(data.user.id, {
    cookieInvite: req.cookies.get(INVITE_COOKIE)?.value ?? null,
    ref: req.cookies.get(REF_COOKIE)?.value ?? null,
    ip: trustedIp(req.headers),
  });
  if (req.cookies.get(INVITE_COOKIE)) response.cookies.set(INVITE_COOKIE, '', { path: '/', maxAge: 0 });

  const payload = {
    user: { id: data.user.id, email: data.user.email },
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    },
  };

  return withAuthCookies(response, payload);
}
