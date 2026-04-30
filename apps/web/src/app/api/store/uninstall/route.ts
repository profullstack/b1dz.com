/**
 * POST /api/store/uninstall
 * Body: { pluginId }
 * Only free plugins can be uninstalled via this endpoint; paid subscription
 * rows require cancellation via Coinpay (handled out-of-band for now).
 */
import type { NextRequest } from 'next/server';
import { PLUGIN_CATALOG } from '@b1dz/core';
import { authenticate, unauthorized } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = await req.json().catch(() => null) as { pluginId?: unknown } | null;
  const pluginId = typeof body?.pluginId === 'string' ? body.pluginId : '';
  if (!pluginId) return Response.json({ error: 'pluginId required' }, { status: 400 });

  const entry = PLUGIN_CATALOG.find((e) => e.manifest.id === pluginId);
  if (!entry) return Response.json({ error: `unknown plugin: ${pluginId}` }, { status: 404 });

  if (entry.pricing.model === 'subscription') {
    return Response.json({ error: 'paid subscriptions cannot be uninstalled — they expire automatically' }, { status: 400 });
  }

  const c = auth.client as unknown as {
    from: (t: string) => {
      delete: () => {
        eq: (col: string, val: string) => {
          eq: (col2: string, val2: string) => Promise<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await c.from('user_installed_plugins')
    .delete()
    .eq('user_id', auth.userId)
    .eq('plugin_id', pluginId);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ uninstalled: true });
}
