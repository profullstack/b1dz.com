import type { NextRequest } from 'next/server';
import { authJson, siteOrigin, withAuthCookies } from '@/lib/auth-route-client';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { email?: string } | null;
  if (!body?.email) return Response.json({ error: 'email required' }, { status: 400 });

  const { response, supabase } = authJson(req, {});
  const { error } = await supabase.auth.resetPasswordForEmail(body.email.trim(), {
    redirectTo: `${siteOrigin(req)}/auth/callback?next=/reset-password`,
  });

  if (error) return Response.json({ error: error.message }, { status: 400 });

  return withAuthCookies(response, { ok: true });
}
