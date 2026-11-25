import type { NextRequest } from 'next/server';
import { tvStart } from '@/lib/tv-oauth';

export const dynamic = 'force-dynamic';

/** Begin connecting an hdtilt.com account for live TV. See lib/tv-oauth.ts. */
export function GET(req: NextRequest) {
  return tvStart(req);
}
