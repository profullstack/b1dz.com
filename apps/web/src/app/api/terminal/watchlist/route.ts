import type { NextRequest } from 'next/server';
import { getWatchlist, putWatchlist } from '@/lib/terminal-api';

export const dynamic = 'force-dynamic';

/** The signed-in user's terminal watchlist. See lib/terminal-api.ts. */
export function GET(req: NextRequest) {
  return getWatchlist(req);
}

export function PUT(req: NextRequest) {
  return putWatchlist(req);
}
