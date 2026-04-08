/**
 * GET /api/storage/:collection
 *   List all rows for the authenticated user in the given collection.
 *
 * Storage adapter routes — the universal CRUD surface that the
 * @b1dz/storage-b1dz-api adapter talks to. RLS scopes everything to the
 * authenticated user automatically.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { COLLECTION_TABLES } from '@/lib/storage-tables';

export async function GET(req: NextRequest, { params }: { params: Promise<{ collection: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { collection } = await params;
  const t = COLLECTION_TABLES[collection];
  if (!t) return Response.json({ error: `unknown collection: ${collection}` }, { status: 404 });
  const { data, error } = await auth.client.from(t.table).select('payload');
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ items: (data ?? []).map(r => r.payload) });
}
