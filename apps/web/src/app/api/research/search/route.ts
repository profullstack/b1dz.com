import type { NextRequest } from 'next/server';
import { researchSearch } from '@/lib/research-api';
import { researchCaller, researchUnauthorized } from '@/lib/research-auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/research/search?q=<ticker | company | CIK | dataset | dashboard>
 *
 * Each hit names the dashboard (and tab) to open and the params to open it
 * with; the cards on that tab are in the catalog at /api/research.
 */
export async function GET(req: NextRequest) {
  if (!(await researchCaller(req))) return researchUnauthorized();
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (!q) return Response.json({ error: 'q is required' }, { status: 400 });
  return Response.json({ query: q, hits: await researchSearch(q) });
}
