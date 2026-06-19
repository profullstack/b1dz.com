import type { NextRequest } from 'next/server';
import { authenticateAgent, unauthorized } from '@/lib/api-auth';
import { placeAgentOrder } from '@/lib/agent-trade';

export const dynamic = 'force-dynamic';

/**
 * Place a crypto BUY on the user's behalf, hard-capped by the token's budget.
 * The order is authorized + enqueued here; the daemon's engine re-checks risk
 * and the global spend budget before actually placing it on the exchange.
 */
export async function POST(req: NextRequest) {
  const agent = await authenticateAgent(req);
  if (!agent) return unauthorized();
  const body = (await req.json().catch(() => null)) as {
    pair?: string;
    exchange?: string;
    usd?: number;
    idempotencyKey?: string;
  } | null;
  if (!body) return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  const result = await placeAgentOrder(agent, {
    pair: body.pair ?? '',
    exchange: body.exchange,
    usd: Number(body.usd),
    idempotencyKey: body.idempotencyKey,
  });
  return Response.json(result.body, { status: result.status });
}
