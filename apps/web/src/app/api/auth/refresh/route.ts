import { createClient } from '@supabase/supabase-js';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { refresh_token?: string } | null;
  if (!body?.refresh_token) return Response.json({ error: 'refresh_token required' }, { status: 400 });
  const client = createClient(URL_, PUB);
  const { data, error } = await client.auth.refreshSession({ refresh_token: body.refresh_token });
  if (error || !data.session) return Response.json({ error: error?.message ?? 'refresh failed' }, { status: 401 });
  return Response.json({
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    },
  });
}
