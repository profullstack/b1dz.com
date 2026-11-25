import type { NextRequest } from 'next/server';
import { postConfirm } from '@/lib/terminal-api';

export const dynamic = 'force-dynamic';

/** Acknowledge a broker warning and send the order. See lib/terminal-api.ts. */
export function POST(req: NextRequest) {
  return postConfirm(req);
}
