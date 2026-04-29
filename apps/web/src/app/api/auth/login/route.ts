import type { NextRequest } from 'next/server';
import { authJson, withAuthCookies } from '@/lib/auth-route-client';

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
