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
import { tsp } from '@b1dz/source-strategies';

export const DEFAULT_AI_MODEL = process.env.STRATEGY_AI_MODEL || 'claude-opus-4-8';

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
  init: { method: string; headers: Record<string, string>; body: string },
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
    body: JSON.stringify({ model, max_tokens: 1500, system: SYSTEM_PROMPT, messages }),
  });
  if (!res.ok) throw new Error(`anthropic http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = JSON.parse(await res.text()) as { content?: { type: string; text?: string }[] };
  return (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

/**
 * Generate a validated TSP strategy from wizard inputs. Throws if the model
 * can't produce a valid document after one repair attempt, or if no API key.
 */
export async function generateStrategy(
  input: GenerateInput,
  opts: { apiKey: string; model?: string; fetchImpl: FetchLike },
): Promise<GeneratedStrategy> {
  if (!opts.apiKey) throw new Error('AI generation is not configured (missing operator API key).');
  const model = opts.model ?? DEFAULT_AI_MODEL;

  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: buildUserPrompt(input) },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await callAnthropic(opts.apiKey, model, opts.fetchImpl, messages);
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
