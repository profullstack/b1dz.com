import type { NextRequest } from 'next/server';
import { authJson, siteOrigin, withAuthCookies } from '@/lib/auth-route-client';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { email?: string; password?: string } | null;
  if (!body?.email || !body?.password) return Response.json({ error: 'email + password required' }, { status: 400 });

  const email = body.email.trim();
  const { response, supabase } = authJson(req, {});
  const { data, error } = await supabase.auth.signUp({
    email,
    password: body.password,
    options: { emailRedirectTo: `${siteOrigin(req)}/auth/callback?next=/dashboard` },
  });

  if (error) return Response.json({ error: error.message }, { status: 400 });
  if (!data.user) return Response.json({ error: 'no user returned' }, { status: 500 });

  const payload = {
    user: { id: data.user.id, email: data.user.email },
    session: data.session && {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    },
    needsEmailConfirmation: !data.session,
  };

  return withAuthCookies(response, payload);
}
