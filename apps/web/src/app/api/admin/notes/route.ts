import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/api-auth';
import { isAdminUser } from '@/lib/monetization';
import { createAdminSupabase } from '@/lib/supabase';
import { requestOrigin } from '@/lib/credits';

export const dynamic = 'force-dynamic';

/** POST /api/admin/notes (form) — a founder-time note on the monetization test page. Admins only. */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth || !isAdminUser(auth.userId)) return Response.json({ error: 'not found' }, { status: 404 });
  const form = await req.formData().catch(() => null);
  const note = String(form?.get('note') ?? '').trim().slice(0, 2000);
  if (note) await createAdminSupabase().from('monetization_notes').insert({ user_id: auth.userId, note });
  return Response.redirect(new URL('/admin', requestOrigin(req)), 303);
}
