import type { NextRequest } from 'next/server';
import { postCancel } from '@/lib/terminal-api';

export const dynamic = 'force-dynamic';

/** Cancel an open order. See lib/terminal-api.ts. */
export function POST(req: NextRequest) {
  return postCancel(req);
}
