import type { NextRequest } from 'next/server';
import { postOrder } from '@/lib/terminal-api';

export const dynamic = 'force-dynamic';

/** Place a manual order through the user's broker. See lib/terminal-api.ts. */
export function POST(req: NextRequest) {
  return postOrder(req);
}
