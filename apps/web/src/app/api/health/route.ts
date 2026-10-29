import { createAdminSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Liveness for status.profullstack.com: the app answers and Supabase answers a
 * one-row head query within 3s. Never says why it failed.
 */
export async function GET() {
  try {
    const { error } = await createAdminSupabase()
      .from('user_settings')
      .select('*', { head: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(3000));
    if (error) throw error;
    return Response.json({ status: 'ok', db: 'ok' }, { headers: NO_STORE });
  } catch {
    return Response.json({ status: 'error', db: 'down' }, { status: 503, headers: NO_STORE });
  }
}
