/**
 * POST /api/invites/accept { code }
 * A new account (INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS or younger) joins on an
 * invite. One per account. The Pro-day bonus follows once the abuse checks pass.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { acceptInvite, INVITE_COOKIE, trustedIp } from '@/lib/credits';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code.trim() : req.cookies.get(INVITE_COOKIE)?.value ?? '';
  if (!code) return Response.json({ error: 'Enter an invite code.', reason: 'invalid' }, { status: 400 });
  const r = await acceptInvite(auth.userId, code, trustedIp(req.headers));
  if (!r.ok) return Response.json({ error: r.message, reason: r.reason }, { status: 400 });
  const res = Response.json(r);
  res.headers.append('set-cookie', `${INVITE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`);
  return res;
}
