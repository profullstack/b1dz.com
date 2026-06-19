import type { NextRequest } from 'next/server';
import { authenticateAgent, unauthorized } from '@/lib/api-auth';
import { getAgentQuote } from '@/lib/agent-trade';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const agent = await authenticateAgent(req);
  if (!agent) return unauthorized();
  const pair = new URL(req.url).searchParams.get('pair') ?? '';
  const { status, body } = await getAgentQuote(agent, pair);
  return Response.json(body, { status });
}
