/**
 * GET /api/store/installed
 * Returns the user's installed plugins + a flag for whether the operator
 * wired up Coinpay merchant credentials.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { coinpayConfigured } from '@/lib/coinpay-client';
import { createAdminSupabase } from '@/lib/supabase';
import { TSP_PLUGIN_PREFIX } from '@/lib/user-strategies';

export const dynamic = 'force-dynamic';

interface InstalledRow {
  plugin_id: string;
  version: string;
  status: string;
  paid_until: string | null;
  installed_at: string;
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const c = auth.client as unknown as {
    from: (t: string) => {
      select: (s: string) => {
        eq: (col: string, val: string) => {
          order: (col: string, opts: { ascending: boolean }) => Promise<{ data: InstalledRow[] | null; error: { message: string } | null }>;
        };
      };
    };
  };
  const { data, error } = await c.from('user_installed_plugins')
    .select('plugin_id, version, status, paid_until, installed_at')
    .eq('user_id', auth.userId)
    .order('installed_at', { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Builder strategies (`tsp:<id>`) have no catalog entry: attach their names.
  const rows: (InstalledRow & { name?: string; strategyId?: string })[] = data ?? [];
  const strategyIds = rows.filter((r) => r.plugin_id.startsWith(TSP_PLUGIN_PREFIX)).map((r) => r.plugin_id.slice(TSP_PLUGIN_PREFIX.length));
  if (strategyIds.length) {
    const { data: strategies } = await createAdminSupabase()
      .from('user_strategies')
      .select('id, name')
      .in('id', strategyIds);
    const names = new Map((strategies ?? []).map((s: { id: string; name: string }) => [s.id, s.name]));
    for (const r of rows) {
      if (!r.plugin_id.startsWith(TSP_PLUGIN_PREFIX)) continue;
      r.strategyId = r.plugin_id.slice(TSP_PLUGIN_PREFIX.length);
      r.name = names.get(r.strategyId) ?? 'Deleted strategy';
    }
  }

  return Response.json({
    installed: rows,
    coinpayConfigured: coinpayConfigured(),
  });
}
