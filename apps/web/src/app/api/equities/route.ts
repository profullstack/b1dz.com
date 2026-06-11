import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/**
 * Enable/disable the daemon's `equities` source for the current user.
 *
 * The daemon's scheduler discovers work by scanning source_state rows; this
 * upserts the row the equities worker keys off (payload.enabled). Broker
 * credentials themselves live in user_settings (saved separately, encrypted).
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  const enabled = body?.enabled === true;

  const c = auth.client as unknown as {
    from: (t: string) => {
      upsert: (vals: Record<string, unknown>, opts: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
    };
  };
  const { error } = await c.from('source_state').upsert(
    { user_id: auth.userId, source_id: 'equities', payload: { enabled }, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,source_id' },
  );
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ enabled });
}
