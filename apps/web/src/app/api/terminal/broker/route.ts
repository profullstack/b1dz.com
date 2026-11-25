import type { NextRequest } from 'next/server';
import { getBroker, putBroker } from '@/lib/terminal-api';

export const dynamic = 'force-dynamic';

/** Linked brokers, buying power, positions and orders. See lib/terminal-api.ts. */
export function GET(req: NextRequest) {
  return getBroker(req);
}

/** Remember which broker the order ticket uses. */
export function PUT(req: NextRequest) {
  return putBroker(req);
}
