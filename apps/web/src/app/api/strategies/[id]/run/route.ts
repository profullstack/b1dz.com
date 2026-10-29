/**
 * /api/strategies/:id/run — switch a strategy on or off for live trading.
 *
 * GET    → { running: boolean }
 * POST   → run it: installs it as plugin `tsp:<id>` (status active). Works on your
 *          own strategies and on anyone's published one.
 * DELETE → stop it (removes the install).
 *
 * The daemon picks the change up within a minute (apps/daemon/src/user-strategies.ts):
 * while you run any strategy for an asset class, it replaces the built-in set
 * for that class. Orders still go through the worker's risk gates and the live
 * execution switches (EQUITY_TRADE_EXECUTION / DEX_TRADE_EXECUTION). The same
 * row shows up under Settings → Plugins, where it can be paused or removed.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { createAdminSupabase } from '@/lib/supabase';
import { isUuid, runPluginId } from '@/lib/user-strategies';

export const dynamic = 'force-dynamic';

const notFound = () => Response.json({ error: 'strategy not found' }, { status: 404 });

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const { data } = await createAdminSupabase()
    .from('user_installed_plugins')
    .select('status')
    .eq('user_id', auth.userId)
    .eq('plugin_id', runPluginId(id))
    .maybeSingle<{ status: string }>();
  return Response.json({ running: data?.status === 'active', installed: !!data });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();

  const admin = createAdminSupabase();
  const { data: strategy } = await admin
    .from('user_strategies')
    .select('id, user_id, visibility')
    .eq('id', id)
    .maybeSingle<{ id: string; user_id: string; visibility: string }>();
  if (!strategy || (strategy.user_id !== auth.userId && strategy.visibility !== 'published')) return notFound();

  const { error } = await admin.from('user_installed_plugins').upsert(
    {
      user_id: auth.userId,
      plugin_id: runPluginId(id),
      version: '1',
      status: 'active',
      paid_until: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,plugin_id' },
  );
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ running: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();
  const { error } = await createAdminSupabase()
    .from('user_installed_plugins')
    .delete()
    .eq('user_id', auth.userId)
    .eq('plugin_id', runPluginId(id));
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ running: false });
}
