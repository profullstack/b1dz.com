import type { NextRequest } from 'next/server';
import { researchPrincipal } from '@/lib/research-auth';
import { askAnalystFor } from '@/lib/research-billing';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/research/analyst  { question: string, cards?: [{ id, params }] }
 *
 * The b1dz AI analyst (latest Opus) answers a market question from research
 * cards: the ones given (at most 4, e.g. the tab open on /terminal) or ones
 * it picks for the question.
 *
 *  - Pro (prepaid pass, credit code, invite days, or a Profullstack Pass):
 *    answers until this month's AI cost reaches PRO_AI_MONTHLY_CAP_USD ($8).
 *  - Free account: FREE_ANALYST_DAILY_QUERIES (5) a day under a monthly cost
 *    cap; every answer carries a watermark line.
 *  - Agents (b1dz_agent_ token or no credential): AGENT_ANALYST_PRICE_USD
 *    ($0.35) per query, by x402 or from prepaid agent credit; 402 otherwise.
 *
 * 400 bad question · 402 payment required / free allowance used · 429 cap or
 * daily limit reached · 502 the model failed · 503 not configured.
 */
export async function POST(req: NextRequest) {
  const caller = await researchPrincipal(req);
  const body = (await req.json().catch(() => ({}))) as { question?: unknown; cards?: unknown };
  const { status, body: out, headers } = await askAnalystFor(caller, req, body);
  return Response.json(out, { status, headers: { ...headers, 'cache-control': 'no-store' } });
}
