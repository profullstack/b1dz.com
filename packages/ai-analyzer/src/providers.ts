/**
 * Dependency-free provider clients (Anthropic + OpenAI), matching the
 * dep-free `fetch` style of the broker clients. Each takes the user's OWN
 * API key and returns raw model JSON, which `analyze()` coerces.
 *
 * Model ids are configurable; the defaults are the latest cost-efficient
 * models for high-frequency scoring (the user pays for their own inference).
 * If you change a default, verify the id against the provider's current
 * catalogue first.
 */

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

export interface AnalyzePromptInput {
  pair: string;
  exchange: string;
  lastPrice: number;
  /** Recent closes oldest→newest (compact context for the model). */
  closes: number[];
  /** The deterministic engine's current signal, for the model to weigh in on. */
  deterministicSignal?: { side: 'buy' | 'sell'; strength: number; reason: string } | null;
}

const SYSTEM_PROMPT =
  'You are a short-term crypto market analyst. Given recent price context and a ' +
  'deterministic strategy signal, classify the market regime and your directional ' +
  'bias. Respond with ONLY a compact JSON object: ' +
  '{"regime":"trending|ranging|volatile","bias":"long|short|neutral","confidence":0..1,"rationale":"<=1 sentence"}. ' +
  'Be conservative: prefer neutral / low confidence in choppy or unclear conditions.';

export function buildUserPrompt(input: AnalyzePromptInput): string {
  const sig = input.deterministicSignal
    ? `${input.deterministicSignal.side} (strength ${input.deterministicSignal.strength.toFixed(2)}): ${input.deterministicSignal.reason}`
    : 'none';
  return [
    `Pair: ${input.pair} on ${input.exchange}`,
    `Last price: ${input.lastPrice}`,
    `Recent closes (old→new): ${input.closes.map((c) => Number(c.toFixed(6))).join(', ')}`,
    `Deterministic signal: ${sig}`,
  ].join('\n');
}

/** Minimal fetch type so this package needs no DOM/node-fetch types. */
type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const getFetch = (f?: FetchLike): FetchLike => f ?? (globalThis.fetch as unknown as FetchLike);

/** Extract the first JSON object from a model text response. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return {};
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
}

export async function callAnthropic(
  apiKey: string,
  input: AnalyzePromptInput,
  opts: { model?: string; fetchImpl?: FetchLike } = {},
): Promise<unknown> {
  const fetchImpl = getFetch(opts.fetchImpl);
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(input) }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = JSON.parse(await res.text()) as { content?: Array<{ type: string; text?: string }> };
  const text = (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return extractJson(text);
}

export async function callOpenAI(
  apiKey: string,
  input: AnalyzePromptInput,
  opts: { model?: string; fetchImpl?: FetchLike } = {},
): Promise<unknown> {
  const fetchImpl = getFetch(opts.fetchImpl);
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_OPENAI_MODEL,
      max_tokens: 256,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = JSON.parse(await res.text()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content ?? '{}';
  return extractJson(text);
}

export type { FetchLike };
