import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { dealDashFetcher } from '@/lib/dealdash-server';

export async function POST(req: NextRequest, { params }: { params: Promise<{ auctionId: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { auctionId } = await params;
  const fetcher = await dealDashFetcher(auth.client);
  if (!fetcher) return Response.json({ error: 'no dealdash session' }, { status: 412 });
  const res = await fetcher(`/api/v1/auction/${auctionId}/bidBuddy`, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return Response.json({ error: text.slice(0, 200), status: res.status }, { status: 502 });
  }
  return Response.json({ ok: true });
}
