/** DELETE /api/invites/:id — withdraw an unused invite (refunds the slot). */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { InviteError, revokeInvite } from '@/lib/credits';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { id } = await ctx.params;
  try {
    await revokeInvite(auth.userId, id);
    return Response.json({ revoked: true });
  } catch (err) {
    if (err instanceof InviteError) return Response.json({ error: err.message, reason: err.reason }, { status: err.status });
    throw err;
  }
}
