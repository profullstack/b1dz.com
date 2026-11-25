import type { NextRequest } from 'next/server';
import type { CardRun } from '@b1dz/research';
import { cardAsCsv, cardAsText } from '@/lib/research-api';
import { researchPrincipal } from '@/lib/research-auth';
import { runCardFor } from '@/lib/research-billing';

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
 * Signed-in people: every card is free. Agents (b1dz_agent_ token, or no
 * credential at all): raw-quote and other free cards are free; metered cards
 * (derived analytics, FRED, EIA; `metered` in the catalog) cost
 * AGENT_CARD_PRICE_USD (default $0.03) per call, paid by x402
 * (PAYMENT-SIGNATURE / X-PAYMENT) or from the account's prepaid agent credit.
 *
 * 401 no credential for a free card · 402 payment required (x402 offer in the
 * body and PAYMENT-REQUIRED) · 404 unknown card · 424 the card needs a free
 * provider key that this server does not have · 502 the public source failed.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const caller = await researchPrincipal(req);
  const { id } = await ctx.params;
  const query = new URL(req.url).searchParams;
  const format = query.get('format') ?? 'json';
  const given: Record<string, string> = {};
  for (const [k, v] of query) if (k !== 'format') given[k] = v;

  const { status, body: raw, headers } = await runCardFor(caller, req, id, given);
  if (status !== 200 || 'error' in raw) return Response.json(raw, { status, headers });
  const body = raw as CardRun;
  if (format === 'csv') {
    return new Response(cardAsCsv(body), { headers: { ...headers, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${id}.csv"` } });
  }
  if (format === 'text') return new Response(`${cardAsText(body)}\n`, { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  return Response.json(body, { headers });
}
