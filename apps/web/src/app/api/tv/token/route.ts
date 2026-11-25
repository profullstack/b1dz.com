import type { NextRequest } from 'next/server';
import { tvToken } from '@/lib/tv-oauth';

export const dynamic = 'force-dynamic';

/** The access token the player sends to hdtilt.com. See lib/tv-oauth.ts. */
export function GET(req: NextRequest) {
  return tvToken(req);
}
