import type { NextRequest } from 'next/server';
import { authenticateAgent, unauthorized } from '@/lib/api-auth';
import { getAgentBudget } from '@/lib/agent-trade';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const agent = await authenticateAgent(req);
  if (!agent) return unauthorized();
  const { status, body } = await getAgentBudget(agent);
  return Response.json(body, { status });
}
