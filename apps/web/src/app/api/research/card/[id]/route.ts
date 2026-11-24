import type { NextRequest } from 'next/server';
import { cardAsCsv, cardAsText, runResearchCard } from '@/lib/research-api';
import { researchCaller, researchUnauthorized } from '@/lib/research-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/research/card/<id>?name=value[&format=json|text|csv]
 *
 * Runs one research card and returns its blocks (tables, charts, stats,
 * text), the source that answered and the data date. Every other query
 * parameter is passed to the card (symbol, country, range, ...); unknown
 * names are ignored and missing ones take the card's default.
 *
 * 404 unknown card · 424 the card needs a free provider key that this server
 * does not have · 502 the public source failed.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await researchCaller(req))) return researchUnauthorized();
  const { id } = await ctx.params;
  const query = new URL(req.url).searchParams;
  const format = query.get('format') ?? 'json';
  const given: Record<string, string> = {};
  for (const [k, v] of query) if (k !== 'format') given[k] = v;

  const { status, body } = await runResearchCard(id, given);
  if (status !== 200 || 'error' in body) return Response.json(body, { status });
  if (format === 'csv') {
    return new Response(cardAsCsv(body), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${id}.csv"` } });
  }
  if (format === 'text') return new Response(`${cardAsText(body)}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return Response.json(body);
}
