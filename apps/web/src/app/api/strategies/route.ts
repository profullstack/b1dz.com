/**
 * /api/strategies — saved strategies from the builder wizard.
 *
 * GET                     → the caller's own strategies (auth), newest first
 * GET ?scope=published    → every published strategy (public, no auth)
 * POST { definition, forkedFrom? } → save a new private strategy (auth)
 *
 * The TSP document is validated + compiled before it is stored; name, slug and
 * description come from the document itself.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { createAdminSupabase } from '@/lib/supabase';
import {
  isDuplicateSlug,
  isUuid,
  OWNER_COLUMNS,
  PUBLIC_COLUMNS,
  strategyFieldsFromDefinition,
} from '@/lib/user-strategies';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('scope') === 'published') {
    const { data, error } = await createAdminSupabase()
      .from('user_strategies')
      .select(PUBLIC_COLUMNS)
      .eq('visibility', 'published')
      .order('published_at', { ascending: false })
      .limit(200);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ strategies: data ?? [] });
  }

  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { data, error } = await auth.client
    .from('user_strategies')
    .select(OWNER_COLUMNS)
    .eq('user_id', auth.userId)
    .order('updated_at', { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ strategies: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as { definition?: unknown; forkedFrom?: unknown };
  const parsed = strategyFieldsFromDefinition(body.definition);
  if (!parsed.ok) return Response.json({ error: 'invalid strategy definition', details: parsed.errors }, { status: 400 });

  const forked_from = isUuid(body.forkedFrom) ? body.forkedFrom : null;
  const { data, error } = await auth.client
    .from('user_strategies')
    .insert({ ...parsed.fields, user_id: auth.userId, forked_from })
    .select(OWNER_COLUMNS)
    .single();
  if (isDuplicateSlug(error)) {
    return Response.json(
      { error: `You already have a strategy with id "${parsed.fields.slug}". Change the ID (slug) and save again.` },
      { status: 409 },
    );
  }
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ strategy: data }, { status: 201 });
}
