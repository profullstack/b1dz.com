/**
 * AI strategy generation for the builder wizard.
 *
 * Turns a few plain-language inputs (niches, goal) plus four 1–10 knobs into a
 * valid TSP (Trading Strategy Protocol) document + a human description, by
 * prompting Claude. The model picks a template or composes rules; we then
 * validate + compile the result and, if it's malformed, do one repair round.
 *
 * Dep-free `fetch` against the Anthropic Messages API — matches the
 * @b1dz/ai-analyzer convention rather than pulling in the SDK. The fetch + API
 * key are injected so the route supplies the operator key and tests stub it.
 *
 * Structured outputs (json_schema) can't constrain the TSP condition grammar —
 * it's recursive (and/or/not → condition), which json-schema strict mode
 * rejects — so we prompt for JSON, extract it, and verify with tsp.compile.
 */
import { resolveAnthropicModel } from '@b1dz/ai-analyzer';
import { tsp } from '@b1dz/source-strategies';

/** `latest` tracks the newest Opus via /v1/models; set a concrete id to pin. */
export const DEFAULT_AI_MODEL = process.env.STRATEGY_AI_MODEL || 'latest';

export interface Knobs {
  /** 1 = conservative … 10 = extreme/aggressive */
  risk: number;
  /** 1 = scalp/short … 10 = long/position */
  horizon: number;
  /** 1 = rare, high-conviction … 10 = very frequent */
  frequency: number;
  /** 1 = equities-tuned … 10 = crypto-tuned */
  assetFocus: number;
}

export interface GenerateInput {
  niches: string;
  goal: string;
  knobs: Knobs;
}

export interface GeneratedStrategy {
  definition: unknown; // a validated TSP document
  description: string;
}

/** Minimal fetch shape so this module needs no DOM/node typings. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const clamp10 = (n: number): number => Math.max(1, Math.min(10, Math.round(Number(n) || 1)));

const SYSTEM_PROMPT = `You design trading strategies as TSP (Trading Strategy Protocol) v0.1 documents — declarative JSON, never code. Output ONLY a single JSON object, no prose, of the form:
{"definition": <TSP document>, "description": "<1-2 sentence plain-English summary>"}

A TSP document:
{"tsp":"0.1","id":"<kebab-slug>","name":"<Name>","assetClasses":["crypto","equity"],"definition": <body>}

The body is one of:
- TEMPLATE: {"kind":"template","template":"mean-reversion"|"breakout"|"trend-continuation","params":{...}}
  - mean-reversion params: period (default 14), oversold (30), overbought (70)
  - breakout params: lookback (20)
  - trend-continuation params: fast (12), slow (26)
- RULES: {"kind":"rules","indicators":{"<name>":{"fn":"rsi"|"ema"|"sma"|"macdHist","period":<n>}},"rules":[{"when":<cond>,"signal":{"side":"buy"|"sell","strength":0..1,"reason":"<text>"}}]}
  rsi needs no period (defaults 14) but may set one; ema/sma require period; macdHist takes no period.
  A condition is a comparison {"gt"|"gte"|"lt"|"lte"|"eq"|"neq":[A,B]} where A/B are a number, the literal "price", or a declared indicator name; or a boolean {"and":[...]}, {"or":[...]}, {"not":<cond>}. First matching rule wins.

Strategies are signals-only and long-only when backtested. Choose template vs rules based on the request.`;

function buildUserPrompt(input: GenerateInput): string {
  const k = input.knobs;
  return [
    `Design a strategy for these niches/themes: ${input.niches || 'general markets'}.`,
    `Investment goal: ${input.goal || 'balanced growth'}.`,
    `Tune to these knobs (1 = mild, 10 = extreme):`,
    `- Risk/aggressiveness ${clamp10(k.risk)}/10 — higher loosens thresholds (e.g. RSI 40/60 vs 20/80) and stronger signals.`,
    `- Time horizon ${clamp10(k.horizon)}/10 — higher uses longer indicator periods (slower EMAs, longer lookbacks).`,
    `- Trade frequency ${clamp10(k.frequency)}/10 — higher means looser entry conditions and more trades.`,
    `- Asset focus ${clamp10(k.assetFocus)}/10 — 1 = tune for equities (steadier, trend-following), 10 = tune for crypto (volatile, faster mean-reversion/breakout). Set assetClasses to match the lean.`,
    `Return only the JSON object described in the system prompt.`,
  ].join('\n');
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callAnthropic(
  apiKey: string,
  model: string,
  fetchImpl: FetchLike,
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<string> {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    // Current models always think, so the budget covers thinking + the JSON.
    body: JSON.stringify({ model, max_tokens: 16000, system: SYSTEM_PROMPT, messages }),
  });
  if (!res.ok) throw new Error(`anthropic http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = JSON.parse(await res.text()) as { content?: { type: string; text?: string }[] };
  return (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

async function callOpenAICompatible(
  fb: FallbackProvider,
  fetchImpl: FetchLike,
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<string> {
  const res = await fetchImpl(`${fb.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${fb.apiKey}` },
    body: JSON.stringify({
      model: fb.model,
      max_tokens: 8000,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`fallback http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = JSON.parse(await res.text()) as { choices?: { message?: { content?: string | null } }[] };
  return body.choices?.[0]?.message?.content ?? '';
}

/** A cheaper OpenAI-compatible endpoint (e.g. Cloudflare Workers AI) used when Claude is unavailable. */
export interface FallbackProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Errors that mean "this key can't be used right now", not "the request was bad". */
export const isProviderUnavailable = (msg: string): boolean =>
  /usage limits|credit balance is too low|http (401|402|403|429|529)/i.test(msg);

type Complete = (messages: { role: 'user' | 'assistant'; content: string }[]) => Promise<string>;

async function draftAndValidate(input: GenerateInput, complete: Complete): Promise<GeneratedStrategy> {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: buildUserPrompt(input) },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await complete(messages);
    const parsed = extractJson(text) as { definition?: unknown; description?: unknown } | null;
    const definition = parsed?.definition;
    const validation = tsp.validateDefinition(definition);

    if (validation.ok) {
      try {
        tsp.compile(definition); // belt-and-suspenders: ensure it actually runs
      } catch (e) {
        if (attempt === 1) throw new Error(`AI produced an uncompilable strategy: ${(e as Error).message}`, { cause: e });
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: `That failed to compile: ${(e as Error).message}. Return corrected JSON only.` });
        continue;
      }
      const description = typeof parsed?.description === 'string' ? parsed.description : '';
      return { definition, description };
    }

    if (attempt === 1) {
      throw new Error(`AI produced an invalid strategy: ${validation.errors.slice(0, 3).join('; ')}`);
    }
    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content: `That document was invalid:\n - ${validation.errors.join('\n - ')}\nReturn corrected JSON only.`,
    });
  }

  throw new Error('AI generation failed.');
}

/**
 * Generate a validated TSP strategy from wizard inputs. Tries Claude first; if
 * the operator key is capped, out of credit or revoked, retries on `fallback`.
 * Throws if no provider is configured or neither yields a valid document.
 */
export async function generateStrategy(
  input: GenerateInput,
  opts: { apiKey: string; model?: string; fetchImpl: FetchLike; fallback?: FallbackProvider },
): Promise<GeneratedStrategy> {
  const { fallback, fetchImpl } = opts;
  if (!opts.apiKey && !fallback) throw new Error('AI generation is not configured (missing operator API key).');
  const viaFallback = () => draftAndValidate(input, (m) => callOpenAICompatible(fallback!, fetchImpl, m));
  if (!opts.apiKey) return viaFallback();

  try {
    const model = await resolveAnthropicModel(opts.apiKey, opts.model ?? DEFAULT_AI_MODEL, fetchImpl);
    return await draftAndValidate(input, (m) => callAnthropic(opts.apiKey, model, fetchImpl, m));
  } catch (e) {
    if (fallback && isProviderUnavailable((e as Error).message)) return viaFallback();
    throw e;
  }
}
