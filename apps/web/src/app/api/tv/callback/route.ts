import type { NextRequest } from 'next/server';
import { tvCallback } from '@/lib/tv-oauth';

export const dynamic = 'force-dynamic';

/** hdtilt.com returns here with the authorization code. See lib/tv-oauth.ts. */
export function GET(req: NextRequest) {
  return tvCallback(req);
}
