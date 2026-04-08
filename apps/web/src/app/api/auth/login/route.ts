import { createClient } from '@supabase/supabase-js';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { email?: string; password?: string } | null;
  if (!body?.email || !body?.password) return Response.json({ error: 'email + password required' }, { status: 400 });
  const client = createClient(URL_, PUB);
  const { data, error } = await client.auth.signInWithPassword({ email: body.email, password: body.password });
  if (error || !data.user || !data.session) return Response.json({ error: error?.message ?? 'login failed' }, { status: 401 });
  return Response.json({
    user: { id: data.user.id, email: data.user.email },
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    },
  });
}
