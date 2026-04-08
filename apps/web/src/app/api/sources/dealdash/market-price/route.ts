/**
 * GET /api/sources/dealdash/market-price?title=<encoded title>
 *
 * Server-side ValueSERP lookup for a product title. Returns the cached result
 * (per-user) or fetches a fresh one and caches it. Per-user cache lives in
 * source_state.payload.caches.marketPrices (same row state-sync writes to,
 * so the TUI hydrates it on startup automatically).
 *
 * This is the first piece of the daemon being lifted out of the TUI: the
 * client no longer needs the VALUESERP_API_KEY at all — the API server
 * holds it and bills against the same plan for every user.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';

interface MarketEntry { min: number; median: number; mean?: number; count: number; }

const VALUESERP = 'https://api.valueserp.com/search';

function cleanTitle(title: string): string {
  return title
    .replace(/^ROYALTY ONLY:\s*/i, '')
    .replace(/^Special\s+Blooming\s+Bargains\s*/i, '')
    .replace(/\s*-\s*Size\s+\d+\s*$/i, '')
    .trim();
}

async function fetchValueSerp(title: string): Promise<MarketEntry> {
  const key = process.env.VALUESERP_API_KEY;
  if (!key) throw new Error('VALUESERP_API_KEY missing on server');
  const url = `${VALUESERP}?api_key=${key}&search_type=shopping&q=${encodeURIComponent(cleanTitle(title).slice(0, 100))}&gl=us`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`valueserp ${res.status}`);
  const data = await res.json() as { shopping_results?: { price_parsed?: { value?: number } }[] };
  const prices = (data.shopping_results || [])
    .map(r => r.price_parsed?.value)
    .filter((n): n is number => typeof n === 'number' && n > 0)
    .sort((a, b) => a - b);
  if (!prices.length) return { min: 0, median: 0, mean: 0, count: 0 };
  const min = prices[0];
  const median = prices[Math.floor(prices.length / 2)];
  const trim = Math.floor(prices.length * 0.2);
  const middle = prices.length > 4 ? prices.slice(trim, prices.length - trim) : prices;
  const mean = middle.reduce((s, n) => s + n, 0) / middle.length;
  return { min, median, mean, count: prices.length };
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const title = req.nextUrl.searchParams.get('title') || '';
  if (!title) return Response.json({ error: 'title required' }, { status: 400 });

  // Read existing source_state row for this user
  const { data: existing } = await auth.client
    .from('source_state')
    .select('payload')
    .eq('source_id', 'dealdash')
    .maybeSingle();
  const payload = (existing?.payload as Record<string, unknown>) ?? {};
  const caches = (payload.caches as Record<string, unknown>) ?? {};
  const marketPrices = (caches.marketPrices as Record<string, MarketEntry>) ?? {};

  // Cache hit?
  if (marketPrices[title]) {
    return Response.json({ value: marketPrices[title], cached: true });
  }

  // Fetch + cache
  let entry: MarketEntry;
  try { entry = await fetchValueSerp(title); }
  catch (e) { return Response.json({ error: (e as Error).message }, { status: 502 }); }
  marketPrices[title] = entry;

  // Upsert the row, preserving other cache slots and credentials
  const newPayload = { ...payload, caches: { ...caches, marketPrices } };
  await auth.client.from('source_state').upsert(
    { user_id: auth.userId, source_id: 'dealdash', payload: newPayload, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,source_id' },
  );

  return Response.json({ value: entry, cached: false });
}
