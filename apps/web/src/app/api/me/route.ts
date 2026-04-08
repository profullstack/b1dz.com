import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  return Response.json({ userId: auth.userId, email: auth.email });
}
