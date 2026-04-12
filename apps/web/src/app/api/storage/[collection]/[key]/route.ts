/**
 * GET    /api/storage/:collection/:key  → get one
 * PUT    /api/storage/:collection/:key  → upsert
 * DELETE /api/storage/:collection/:key  → delete
 */
import type { NextRequest } from 'next/server';
import { deleteRuntimeSourceState, getRuntimeSourceState, setRuntimeSourceState, stripLiveSourceState } from '@b1dz/core';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { COLLECTION_TABLES } from '@/lib/storage-tables';

interface Ctx { params: Promise<{ collection: string; key: string }> }

function resolve(collection: string) {
  const t = COLLECTION_TABLES[collection];
  if (!t) return null;
  return t;
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { collection, key } = await params;
  const t = resolve(collection);
  if (!t) return Response.json({ error: `unknown collection: ${collection}` }, { status: 404 });
  if (collection === 'source-state') {
    const cached = await getRuntimeSourceState<Record<string, unknown>>(auth.userId, key);
    if (cached) return Response.json({ value: cached });
  }
  const { data, error } = await auth.client.from(t.table).select('payload').eq(t.pk, key).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const value = collection === 'source-state'
    ? stripLiveSourceState<Record<string, unknown>>(data?.payload as Record<string, unknown> | null)
    : (data?.payload ?? null);
  return Response.json({ value });
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { collection, key } = await params;
  const t = resolve(collection);
  if (!t) return Response.json({ error: `unknown collection: ${collection}` }, { status: 404 });
  const value = await req.json().catch(() => null);
  if (value == null) return Response.json({ error: 'body required' }, { status: 400 });

  // Build the row, denormalizing common fields onto top-level columns.
  // The `id` column only exists on tables whose PK actually is `id` —
  // source_state uses a composite (user_id, source_id) and has no id column.
  const v = value as Record<string, unknown>;
  const row: Record<string, unknown> = {
    user_id: auth.userId,
    payload: value,
    updated_at: new Date().toISOString(),
  };
  if (t.pk === 'id') row.id = key;
  if (t.pk === 'source_id') row.source_id = key;
  if (typeof v.sourceId === 'string' && t.pk !== 'source_id') row.source_id = v.sourceId;
  if (typeof v.level === 'string') row.level = v.level;
  if (t.table === 'alerts' && typeof v.at === 'number') row.at = new Date(v.at).toISOString();

  const conflict = t.table === 'source_state' ? 'user_id,source_id' : t.pk;
  const { error } = await auth.client.from(t.table).upsert(row, { onConflict: conflict });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (collection === 'source-state') await setRuntimeSourceState(auth.userId, key, value as Record<string, unknown>);
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { collection, key } = await params;
  const t = resolve(collection);
  if (!t) return Response.json({ error: `unknown collection: ${collection}` }, { status: 404 });
  const { error } = await auth.client.from(t.table).delete().eq(t.pk, key);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (collection === 'source-state') await deleteRuntimeSourceState(auth.userId, key);
  return Response.json({ ok: true });
}
