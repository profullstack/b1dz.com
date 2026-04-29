import type { NextRequest } from 'next/server';
import { authJson, withAuthCookies } from '@/lib/auth-route-client';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { password?: string } | null;
  if (!body?.password) return Response.json({ error: 'password required' }, { status: 400 });
  if (body.password.length < 8) return Response.json({ error: 'password must be at least 8 characters' }, { status: 400 });

  const { response, supabase } = authJson(req, {});
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return Response.json({ error: 'reset session expired; request another password reset email' }, { status: 401 });

  const { error } = await supabase.auth.updateUser({ password: body.password });
  if (error) return Response.json({ error: error.message }, { status: 400 });

  return withAuthCookies(response, { ok: true });
}
