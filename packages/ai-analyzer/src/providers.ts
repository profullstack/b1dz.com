/**
 * Dependency-free provider clients (Anthropic + OpenAI), matching the
 * dep-free `fetch` style of the broker clients. Each takes the user's OWN
 * API key and returns raw model JSON, which `analyze()` coerces.
 *
 * Anthropic models default to the alias `latest`: the newest Opus the key can
 * see, resolved from GET /v1/models (cached), so a new model generation is
 * picked up without a deploy. `latest-sonnet` / `latest-haiku` track the
 * cheaper tiers; any concrete id (e.g. `claude-opus-5-5`) pins one model.
 */

export const LATEST_ALIAS = 'latest';
/** Used when /v1/models can't be reached. Bump when a new generation ships. */
export const FALLBACK_ANTHROPIC_MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
} as const;
export type AnthropicFamily = keyof typeof FALLBACK_ANTHROPIC_MODELS;
export const DEFAULT_ANTHROPIC_MODEL = LATEST_ALIAS;
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
  body?: string;
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const getFetch = (f?: FetchLike): FetchLike => f ?? (globalThis.fetch as unknown as FetchLike);

const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;
const modelCache = new Map<AnthropicFamily, { id: string; at: number }>();

/** Test hook: forget resolved aliases. */
export function clearModelCache(): void {
  modelCache.clear();
}

/** `latest` → opus, `latest-sonnet` → sonnet, …; null for a concrete model id. */
export function aliasFamily(model: string | undefined): AnthropicFamily | null {
  const m = (model ?? '').trim().toLowerCase();
  if (m === '' || m === LATEST_ALIAS) return 'opus';
  const fam = m.startsWith(`${LATEST_ALIAS}-`) ? m.slice(LATEST_ALIAS.length + 1) : '';
  return fam in FALLBACK_ANTHROPIC_MODELS ? (fam as AnthropicFamily) : null;
}

/**
 * Resolve a model setting to a concrete Anthropic id. Aliases pick the newest
 * `claude-<family>-*` by created_at; any failure falls back to the pinned id
 * so a models-API hiccup never stops analysis.
 */
export async function resolveAnthropicModel(
  apiKey: string,
  model: string | undefined,
  fetchImpl?: FetchLike,
): Promise<string> {
  const family = aliasFamily(model);
  if (!family) return model!.trim();
  const hit = modelCache.get(family);
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.id;
  let id: string = FALLBACK_ANTHROPIC_MODELS[family];
  try {
    const res = await getFetch(fetchImpl)('https://api.anthropic.com/v1/models?limit=1000', {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (res.ok) {
      const body = JSON.parse(await res.text()) as { data?: Array<{ id?: string; created_at?: string }> };
      const newest = (body.data ?? [])
        .filter((m) => typeof m.id === 'string' && m.id.startsWith(`claude-${family}-`))
        .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''))[0];
      if (newest?.id) id = newest.id;
    }
  } catch { /* keep the fallback */ }
  modelCache.set(family, { id, at: Date.now() });
  return id;
}

/** Effort exists on Claude 5+ and Opus/Sonnet 4.6+; older models reject it. */
export function supportsEffort(model: string): boolean {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return false;
  const major = Number(m[2]);
  const minor = Number(m[3] ?? 0);
  if (major >= 5) return true;
  return major === 4 && m[1] !== 'haiku' && minor >= 6 && minor < 100;
}

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
  const model = await resolveAnthropicModel(apiKey, opts.model, opts.fetchImpl);
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      // Current models always think; leave room so the JSON isn't cut off.
      max_tokens: 4000,
      // Regime scoring is a quick read run every 30s: keep thinking shallow.
      ...(supportsEffort(model) ? { output_config: { effort: 'low' } } : {}),
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
