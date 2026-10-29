/**
 * /api/strategies/:id
 *
 * GET    → the strategy, if it is yours or published (no auth needed for published)
 * PATCH  { definition } → replace its TSP document (owner). Changing the logic of a
 *          published strategy takes it back to private (DB trigger): its listed
 *          backtest no longer describes it, so publish again to refresh it.
 * DELETE → remove it (owner)
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { createAdminSupabase } from '@/lib/supabase';
import {
  isDuplicateSlug,
  isUuid,
  OWNER_COLUMNS,
  strategyFieldsFromDefinition,
  type UserStrategyRow,
} from '@/lib/user-strategies';

export const dynamic = 'force-dynamic';

const notFound = () => Response.json({ error: 'strategy not found' }, { status: 404 });

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();

  const auth = await authenticate(req);
  const { data } = await createAdminSupabase()
    .from('user_strategies')
    .select(OWNER_COLUMNS)
    .eq('id', id)
    .maybeSingle<UserStrategyRow>();
  if (!data) return notFound();
  const owned = !!auth && data.user_id === auth.userId;
  if (!owned && data.visibility !== 'published') return notFound();
  const { user_id: _userId, ...listing } = data;
  return Response.json({ strategy: owned ? data : listing, owned });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();

  const body = (await req.json().catch(() => ({}))) as { definition?: unknown };
  const parsed = strategyFieldsFromDefinition(body.definition);
  if (!parsed.ok) return Response.json({ error: 'invalid strategy definition', details: parsed.errors }, { status: 400 });

  const { data, error } = await auth.client
    .from('user_strategies')
    .update(parsed.fields)
    .eq('id', id)
    .eq('user_id', auth.userId)
    .select(OWNER_COLUMNS)
    .maybeSingle();
  if (isDuplicateSlug(error)) {
    return Response.json({ error: `You already have a strategy with id "${parsed.fields.slug}".` }, { status: 409 });
  }
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return notFound();
  return Response.json({ strategy: data });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound();

  const { data, error } = await auth.client
    .from('user_strategies')
    .delete()
    .eq('id', id)
    .eq('user_id', auth.userId)
    .select('id');
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data?.length) return notFound();
  return Response.json({ deleted: id });
}
