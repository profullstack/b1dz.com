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

  // With email confirmation enabled, Supabase deliberately returns an IDENTICAL
  // response for a brand-new email and an already-registered one — no error, no
  // session, and (via supabase-js) a null user — to prevent email enumeration.
  // We therefore can't (and must not) tell the user "already registered"; we
  // just report that a confirmation email is on its way. If a session IS present
  // (confirmation disabled), the user is signed in immediately.
  const payload = {
    user: data.user ? { id: data.user.id, email: data.user.email } : null,
    session: data.session && {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    },
    needsEmailConfirmation: !data.session,
  };

  return withAuthCookies(response, payload);
}
