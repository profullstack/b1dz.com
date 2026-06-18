import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

/** Revoke an agent token (soft delete — sets revoked_at). RLS scopes to owner. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { id } = await params;
  const { error } = await auth.client
    .from('agent_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', auth.userId);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ revoked: id });
}
