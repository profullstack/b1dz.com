/**
 * GET /api/storage/:collection
 *   List all rows for the authenticated user in the given collection.
 *
 * Storage adapter routes — the universal CRUD surface that the
 * @b1dz/storage-b1dz-api adapter talks to. RLS scopes everything to the
 * authenticated user automatically.
 */
import type { NextRequest } from 'next/server';
import { listRuntimeSourceStates, stripLiveSourceState } from '@b1dz/core';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { COLLECTION_TABLES } from '@/lib/storage-tables';

export async function GET(req: NextRequest, { params }: { params: Promise<{ collection: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { collection } = await params;
  const t = COLLECTION_TABLES[collection];
  if (!t) return Response.json({ error: `unknown collection: ${collection}` }, { status: 404 });
  const select = collection === 'source-state' ? 'source_id,payload' : 'payload';
  const { data, error } = await auth.client.from(t.table).select(select);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (collection !== 'source-state') {
    const rows = (data ?? []) as Array<{ payload?: unknown }>;
    return Response.json({ items: rows.map((r) => r.payload) });
  }

  const persisted = new Map<string, Record<string, unknown>>();
  for (const row of (data ?? []) as Array<{ source_id?: string; payload?: Record<string, unknown> }>) {
    if (!row.source_id) continue;
    persisted.set(row.source_id, stripLiveSourceState(row.payload ?? {}) ?? {});
  }
  for (const row of await listRuntimeSourceStates<Record<string, unknown>>(auth.userId)) {
    persisted.set(row.sourceId, row.value);
  }
  return Response.json({ items: [...persisted.values()] });
}
