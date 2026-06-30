/**
 * POST /api/strategies/generate
 *
 * AI-drafts a TSP strategy for the builder wizard from a few inputs (niches,
 * goal) + four 1–10 knobs. Auth-gated and rate-limited per user — it spends the
 * OPERATOR's Anthropic key, so we guard against the shared-key quota/abuse trap.
 *
 * Body: { niches?: string, goal?: string, knobs: { risk, horizon, frequency, assetFocus } }
 * Returns: { definition: <TSP doc>, description: string }
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { generateStrategy, type FetchLike, type GenerateInput } from '@/lib/strategy-ai';

export const maxDuration = 60;

// Crude in-memory per-user limiter. Good enough for a single instance; swap for
// a shared store if this runs multi-replica.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 8;
const hits = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(userId, recent);
    return true;
  }
  recent.push(now);
  hits.set(userId, recent);
  return false;
}

interface GenerateBody {
  niches?: string;
  goal?: string;
  knobs?: Partial<GenerateInput['knobs']>;
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'AI generation is not configured on this server.' }, { status: 503 });
  }

  if (rateLimited(auth.userId)) {
    return Response.json({ error: 'Too many generations — wait a moment and try again.' }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as GenerateBody;
  const k = body.knobs ?? {};
  const input: GenerateInput = {
    niches: String(body.niches ?? '').slice(0, 300),
    goal: String(body.goal ?? '').slice(0, 300),
    knobs: {
      risk: Number(k.risk ?? 5),
      horizon: Number(k.horizon ?? 5),
      frequency: Number(k.frequency ?? 5),
      assetFocus: Number(k.assetFocus ?? 5),
    },
  };

  try {
    const result = await generateStrategy(input, { apiKey, fetchImpl: globalThis.fetch as unknown as FetchLike });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
