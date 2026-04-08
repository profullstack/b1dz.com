import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { dealDashFetcher } from '@/lib/dealdash-server';

function extractAuctionFeed(html: string): Record<string, unknown> | null {
  const marker = 'dd.auctionFeed';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const eq = html.indexOf('=', start);
  if (eq === -1) return null;
  let i = eq + 1;
  while (i < html.length && html[i] !== '{') i++;
  if (i >= html.length) return null;
  const objStart = i;
  let depth = 0, inStr = false, escape = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  try { return JSON.parse(html.slice(objStart, i)); } catch { return null; }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ auctionId: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { auctionId } = await params;
  const fetcher = await dealDashFetcher(auth.client);
  if (!fetcher) return Response.json({ error: 'no dealdash session' }, { status: 412 });
  const res = await fetcher(`/auction/${auctionId}`);
  if (!res.ok) return Response.json({ error: `dealdash ${res.status}` }, { status: 502 });
  const html = await res.text();
  const feed = extractAuctionFeed(html);
  const entry = feed?.auctions && (feed.auctions as Record<string, Record<string, unknown>>)['static']?.[auctionId]
    || (feed?.auctions as { static?: Record<string, unknown> })?.static?.[auctionId];
  if (!entry) return Response.json({ value: null });
  const e = entry as Record<string, unknown>;
  return Response.json({
    value: {
      name: e.name,
      categoryName: e.categoryName,
      buyItNowPrice: e.buyItNowPrice,
      exchangeable: e.exchangeable,
      productId: e.productId,
      noReEntry: e.noReEntry,
      exchangedAt: e.exchangedAt,
      exchangedFor: e.exchangedFor,
    },
  });
}
