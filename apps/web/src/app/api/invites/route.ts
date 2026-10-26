/**
 * GET  /api/invites          quota, invites sent, bonus state, Pro-day balance, affiliate link
 * POST /api/invites { note } create an invite; the code is returned once, never stored in plaintext
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { createInvite, inviteOverview, inviteUrl, InviteError, requestOrigin, trustedIp } from '@/lib/credits';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const overview = await inviteOverview(auth.userId);
  const origin = requestOrigin(req);
  return Response.json({ ...overview, affiliateUrl: `${origin}/?ref=${encodeURIComponent(overview.affiliateCode)}` });
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
  const note = typeof body?.note === 'string' ? body.note : '';
  try {
    const invite = await createInvite(auth.userId, note, trustedIp(req.headers));
    return Response.json({
      id: invite.id,
      code: invite.code,
      url: inviteUrl(requestOrigin(req), invite.code),
      expiresAt: invite.expiresAt,
    });
  } catch (err) {
    if (err instanceof InviteError) return Response.json({ error: err.message, reason: err.reason }, { status: err.status });
    throw err;
  }
}
