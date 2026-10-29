/**
 * /api/strategies/:id/publish
 *
 * POST   → publish your strategy to the store. Reruns the backtest server-side
 *          (1 year, $1,000, crypto + equities) and stores that snapshot, so the
 *          numbers on a listing are ours, not the author's.
 * DELETE → unpublish (back to private).
 *
 * Publishing state is writable only by the service role (column grants in the
 * user_strategies migration), so ownership is checked here explicitly.
 */
import type { NextRequest } from 'next/server';
import { tsp } from '@b1dz/source-strategies';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { createAdminSupabase } from '@/lib/supabase';
import { runStrategyBacktest } from '@/lib/strategy-backtest-runner';
import { fetchCloses } from '@/lib/strategy-closes';
import { authorDisplayName, isUuid, OWNER_COLUMNS, type UserStrategyRow } from '@/lib/user-strategies';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const notFound = () => Response.json({ error: 'strategy not found' }, { status: 404 });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();

  const admin = createAdminSupabase();
  const { data: row } = await admin
    .from('user_strategies')
    .select(OWNER_COLUMNS)
    .eq('id', id)
    .eq('user_id', auth.userId)
    .maybeSingle<UserStrategyRow>();
  if (!row) return notFound();

  let plugin;
  try {
    plugin = tsp.compile(row.definition);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  const backtest = await runStrategyBacktest(plugin, {
    classes: ['crypto', 'equity'],
    bankroll: 1000,
    timeframe: '1 year',
    fetchCloses,
  });

  const { data: profile } = await admin
    .from('user_profiles')
    .select('first_name, last_name')
    .eq('user_id', auth.userId)
    .maybeSingle();
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from('user_strategies')
    .update({
      visibility: 'published',
      published_at: row.published_at ?? now,
      backtest,
      backtested_at: now,
      author_name: authorDisplayName(profile),
    })
    .eq('id', id)
    .eq('user_id', auth.userId)
    .select(OWNER_COLUMNS)
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ strategy: data });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();

  const { data, error } = await createAdminSupabase()
    .from('user_strategies')
    .update({ visibility: 'private', published_at: null })
    .eq('id', id)
    .eq('user_id', auth.userId)
    .select(OWNER_COLUMNS)
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return notFound();
  return Response.json({ strategy: data });
}
