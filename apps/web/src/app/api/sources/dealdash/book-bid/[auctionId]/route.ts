import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { dealDashFetcher } from '@/lib/dealdash-server';

export async function POST(req: NextRequest, { params }: { params: Promise<{ auctionId: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { auctionId } = await params;
  const body = await req.json().catch(() => ({})) as { count?: number };
  const count = Math.max(1, Number(body.count || 1));
  const fetcher = await dealDashFetcher(auth.client);
  if (!fetcher) return Response.json({ error: 'no dealdash session — connect first' }, { status: 412 });
  const res = await fetcher(`/api/v1/auction/${auctionId}/bidBuddy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return Response.json({ error: text.slice(0, 200), status: res.status }, { status: 502 });
  }
  return Response.json({ ok: true, count });
}
