/**
 * The b1dz AI analyst: one question, answered by the latest Opus from the
 * research cards the question needs (or the cards the caller is looking at).
 *
 * Two steps so the caller can refuse BEFORE spending: prepareAnalyst() runs
 * the cards and builds the prompt (its size bounds the worst-case cost), and
 * callAnalyst() makes the one Messages call and returns the usage block, from
 * which the real cost is recorded.
 *
 * Dep-free fetch against the Anthropic Messages API, matching strategy-ai.ts
 * and @b1dz/ai-analyzer. Research only, not investment advice.
 */
import { resolveAnthropicModel } from '@b1dz/ai-analyzer';
import { registry, type SearchHit } from '@b1dz/research';
import { usageCostUsd, worstCaseCostUsd, type Usage } from './monetization';

export const ANALYST_MAX_CARDS = 4;

function envRaw(name: string): string | undefined {
  const v = (process.env as Record<string, string | undefined>)[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}
export const analystModelSetting = () => envRaw('ANALYST_AI_MODEL') ?? 'latest';
export const analystMaxTokens = () => Math.max(1000, Math.min(16000, Number(envRaw('ANALYST_MAX_TOKENS') ?? 6000) || 6000));
const analystEffort = () => (['low', 'medium', 'high'].includes(envRaw('ANALYST_EFFORT') ?? '') ? envRaw('ANALYST_EFFORT')! : 'medium');

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface CardRef {
  id: string;
  params?: Record<string, string>;
}

export interface CardContext {
  id: string;
  title: string;
  source: string;
  asOf?: string;
  text: string;
}

export interface AnalystDeps {
  runCard: (id: string, params: Record<string, string>) => Promise<CardContext | null>;
  search: (query: string) => Promise<SearchHit[]>;
}

export const SYSTEM_PROMPT = `You are the b1dz research analyst. Answer the user's market question from the research cards supplied (tables from public and official sources), plus general knowledge where the cards are silent.
- Lead with the answer in one or two sentences, then the evidence: name the card and its source for every figure you use, with the data date when given.
- Say plainly when the cards do not cover something or the data is stale. Never invent a number.
- Keep it under about 250 words unless the question needs a table.
- This is research, not investment advice: no instructions to buy or sell.`;

function cleanCards(given: unknown): CardRef[] {
  if (!Array.isArray(given)) return [];
  const out: CardRef[] = [];
  for (const g of given) {
    if (!g || typeof g !== 'object') continue;
    const id = String((g as { id?: unknown }).id ?? '');
    if (!registry().card(id)) continue;
    const raw = (g as { params?: unknown }).params;
    const params: Record<string, string> = {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') params[k] = String(v).slice(0, 200);
      }
    }
    out.push({ id, params });
    if (out.length >= ANALYST_MAX_CARDS) break;
  }
  return out;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'what', 'how', 'why', 'does', 'do', 'it', 'its', 'vs', 'with', 'me', 'about', 'now', 'today', 'this', 'that']);

/** Cards for a question nobody chose cards for: a ticker's dashboard if it names one, else the best title matches. */
export async function pickCards(question: string, deps: Pick<AnalystDeps, 'search'>): Promise<CardRef[]> {
  const reg = registry();
  const hits = await deps.search(question).catch(() => [] as SearchHit[]);
  const sec = hits.find((h) => h.kind === 'security' && h.params && Object.keys(h.params).length > 0);
  if (sec) {
    const dash = reg.dashboard(sec.dashboard);
    const ids = dash?.tabs[0]?.cards.filter((id) => reg.card(id)).slice(0, 3) ?? [];
    if (ids.length) return ids.map((id) => ({ id, params: sec.params }));
  }
  const words = question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const scored = reg
    .allCards()
    .filter((c) => !c.needsKey)
    .map((c) => {
      const hay = `${c.title} ${c.description ?? ''} ${c.id}`.toLowerCase();
      return { id: c.id, score: words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => ({ id: x.id }));
  return scored.length ? scored : [{ id: 'overview.us-indices' }, { id: 'rates.curve' }, { id: 'macro.news-markets' }];
}

export interface PreparedAnalyst {
  question: string;
  user: string;
  sources: Omit<CardContext, 'text'>[];
  promptChars: number;
}

export async function prepareAnalyst(input: { question: string; cards?: unknown }, deps: AnalystDeps): Promise<PreparedAnalyst> {
  const question = String(input.question ?? '').trim().slice(0, 2000);
  const chosen = cleanCards(input.cards);
  const refs = chosen.length ? chosen : await pickCards(question, deps);
  const runs = (await Promise.all(refs.map((r) => deps.runCard(r.id, r.params ?? {}).catch(() => null)))).filter((x): x is CardContext => !!x);
  const blocks = runs.map((r) => `### ${r.title} (${r.id})\nSource: ${r.source}${r.asOf ? `, as of ${r.asOf}` : ''}\n${r.text.slice(0, 12_000)}`);
  const user = `Research cards:\n\n${blocks.join('\n\n') || '(no card data was available)'}\n\nQuestion: ${question}`;
  return {
    question,
    user,
    sources: runs.map(({ id, title, source, asOf }) => ({ id, title, source, ...(asOf ? { asOf } : {}) })),
    promptChars: user.length + SYSTEM_PROMPT.length,
  };
}

export async function analystWorstCase(apiKey: string, prepared: PreparedAnalyst, fetchImpl?: FetchLike): Promise<{ model: string; worstCaseUsd: number }> {
  const model = await resolveAnthropicModel(apiKey, analystModelSetting(), fetchImpl);
  return { model, worstCaseUsd: worstCaseCostUsd(model, prepared.promptChars, analystMaxTokens()) };
}

export interface AnalystAnswer {
  answer: string;
  model: string;
  usage: Usage;
  costUsd: number;
}

export async function callAnalyst(apiKey: string, model: string, prepared: PreparedAnalyst, fetchImpl: FetchLike): Promise<AnalystAnswer> {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: analystMaxTokens(),
      system: SYSTEM_PROMPT,
      output_config: { effort: analystEffort() },
      messages: [{ role: 'user', content: prepared.user }],
    }),
    signal: AbortSignal.timeout(110_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`anthropic http ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { model?: string; content?: { type: string; text?: string }[]; usage?: Usage; stop_reason?: string };
  const usage = body.usage ?? {};
  const used = body.model ?? model;
  let answer = (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  if (body.stop_reason === 'refusal') answer = 'The analyst declined to answer that question.';
  if (!answer) answer = 'The analyst returned no answer. Try rephrasing the question.';
  return { answer, model: used, usage, costUsd: usageCostUsd(used, usage) };
}
