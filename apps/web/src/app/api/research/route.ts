import type { NextRequest } from 'next/server';
import { researchCatalog } from '@/lib/research-api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/research[?q=text]
 *
 * The research catalog: dashboards with their tabs, and every card with its
 * id, source, params and whether it needs a free provider key. Public: it is
 * a list of what exists, not data.
 *
 * Run a card with GET /api/research/card/<id>?name=value.
 */
export function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams.get('q') ?? undefined;
  const { dashboards, cards } = researchCatalog(q);
  return Response.json(
    { dashboards, cards, run: '/api/research/card/{id}?name=value', search: '/api/research/search?q=' },
    { headers: { 'cache-control': 'public, max-age=300' } },
  );
}
