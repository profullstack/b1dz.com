import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

type UpdateBuilder = {
  eq: (col: string, val: string) => {
    eq: (col2: string, val2: string) => Promise<{ error: { message: string } | null }>;
  };
};

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = await req.json().catch(() => null) as { pluginId?: unknown } | null;
  const pluginId = typeof body?.pluginId === 'string' ? body.pluginId : '';
  if (!pluginId) return Response.json({ error: 'pluginId required' }, { status: 400 });

  const c = auth.client as unknown as {
    from: (t: string) => { update: (vals: Record<string, unknown>) => UpdateBuilder };
  };
  const { error } = await c.from('user_installed_plugins')
    .update({ status: 'disabled', updated_at: new Date().toISOString() })
    .eq('user_id', auth.userId)
    .eq('plugin_id', pluginId);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ disabled: true });
}
