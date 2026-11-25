import type { NextRequest } from 'next/server';
import { tvDisconnect } from '@/lib/tv-oauth';

export const dynamic = 'force-dynamic';

/** Revoke the hdtilt.com connection and forget its tokens. See lib/tv-oauth.ts. */
export function POST(req: NextRequest) {
  return tvDisconnect(req);
}
