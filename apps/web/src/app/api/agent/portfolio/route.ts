import type { NextRequest } from 'next/server';
import { authenticateAgent, unauthorized } from '@/lib/api-auth';
import { getAgentPortfolio } from '@/lib/agent-trade';
import { tokenHasScope } from '@b1dz/core';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const agent = await authenticateAgent(req);
  if (!agent) return unauthorized();
  if (!tokenHasScope(agent.token, 'read')) return Response.json({ error: 'token lacks read scope' }, { status: 403 });
  const { status, body } = await getAgentPortfolio(agent);
  return Response.json(body, { status });
}
