/**
 * POST /api/strategies/generate
 *
 * AI-drafts a TSP strategy for the builder wizard from a few inputs (niches,
 * goal) + four 1–10 knobs. Auth-gated and rate-limited per user — it spends the
 * OPERATOR's Anthropic key, so we guard against the shared-key quota/abuse trap.
 * When that key is capped or revoked it falls back to a cheaper OpenAI-compatible
 * endpoint (AI_FALLBACK_URL / AI_FALLBACK_API_KEY / AI_FALLBACK_MODEL, e.g.
 * Cloudflare Workers AI).
 *
 * Body: { niches?: string, goal?: string, knobs: { risk, horizon, frequency, assetFocus } }
 * Returns: { definition: <TSP doc>, description: string }
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import {
  generateStrategy,
  isProviderUnavailable,
  type FallbackProvider,
  type FetchLike,
  type GenerateInput,
} from '@/lib/strategy-ai';

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

const DEFAULT_FALLBACK_MODEL = '@cf/openai/gpt-oss-120b';

function fallbackProvider(): FallbackProvider | undefined {
  const baseUrl = process.env.AI_FALLBACK_URL;
  const apiKey = process.env.AI_FALLBACK_API_KEY;
  if (!baseUrl || !apiKey) return undefined;
  return { baseUrl, apiKey, model: process.env.AI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL };
}

interface GenerateBody {
  niches?: string;
  goal?: string;
  knobs?: Partial<GenerateInput['knobs']>;
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  const fallback = fallbackProvider();
  if (!apiKey && !fallback) {
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
    const result = await generateStrategy(input, {
      apiKey,
      fallback,
      fetchImpl: globalThis.fetch as unknown as FetchLike,
    });
    return Response.json(result);
  } catch (e) {
    const msg = (e as Error).message;
    // The operator key is shared and capped: say so plainly instead of dumping provider JSON.
    if (isProviderUnavailable(msg)) {
      return Response.json(
        { error: 'AI generation is over its spend limit right now. Try again later, or build the strategy by hand.' },
        { status: 503 },
      );
    }
    return Response.json({ error: msg }, { status: 502 });
  }
}
