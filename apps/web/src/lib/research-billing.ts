/**
 * Research cards and the AI analyst, with the money rules applied. Shared by
 * the HTTP API (/api/research/card/<id>, /api/research/analyst) and the MCP
 * server (research_card, research_analyst).
 */
import { cardBilling, registry, type CardRun } from '@b1dz/research';
import { chargeAgent, settleAfter, supabasePayStore, type Charge, type Payer, type PayResult, type PayStore } from './agent-pay';
import { analystWorstCase, callAnalyst, prepareAnalyst, type AnalystDeps, type FetchLike } from './analyst';
import { getCreditDeps } from './credits';
import { freeGlobalMonthCost, getEntitlement, recordUsage, userUsage } from './entitlements';
import { analystAllowance, monetizationConfig, watermark, type Tier } from './monetization';
import { cardAsText, researchSearch, runResearchCard, type ApiResult } from './research-api';
import type { ResearchCaller } from './research-auth';
import { createAdminSupabase } from './supabase';

export interface Outcome<T> {
  status: number;
  body: T | Record<string, unknown>;
  headers: Record<string, string>;
}

let storeOverride: PayStore | undefined;
export function setPayStoreForTest(s: PayStore | undefined) {
  storeOverride = s;
}
async function payStore(): Promise<PayStore> {
  if (storeOverride) return storeOverride;
  return supabasePayStore(createAdminSupabase() as never, (await getCreditDeps()).credits);
}

const payerOf = (c: ResearchCaller): Payer =>
  c.kind === 'agent' ? { userId: c.userId, agentTokenId: c.agentTokenId } : { userId: null, agentTokenId: null };

export function isMetered(id: string): boolean {
  const card = registry().card(id);
  return !!card && cardBilling(card).metered;
}

/** Run a card for this caller: free unless an agent asks for a metered card. */
export async function runCardFor(
  caller: ResearchCaller,
  req: { headers: Headers },
  id: string,
  params: Record<string, unknown>,
  run: (id: string, params: Record<string, unknown>) => Promise<ApiResult<CardRun>> = runResearchCard,
): Promise<Outcome<CardRun>> {
  const card = registry().card(id);
  if (!card) return { status: 404, body: { error: `unknown card: ${id}. List them with GET /api/research` }, headers: {} };
  const metered = cardBilling(card).metered;
  if (caller.kind === 'user' || !metered) {
    if (caller.kind === 'anon') {
      return { status: 401, body: { error: 'unauthorized: sign in, or send Authorization: Bearer <b1dz_agent_ token>. The catalog at /api/research is public.' }, headers: {} };
    }
    const r = await run(id, params);
    return { status: r.status, body: r.body, headers: {} };
  }

  const cfg = monetizationConfig();
  const charge: Charge = { resource: `research/card/${id}`, priceUsd: cfg.cardPriceUsd, description: `b1dz research card ${id}` };
  const payer = payerOf(caller);
  const store = await payStore();
  const paid = await chargeAgent(req, charge, payer, store);
  if (!paid.ok) return { status: paid.status, body: paid.body, headers: paid.headers };
  const r = await run(id, params);
  await settleAfter(store, paid, payer, charge, r.status === 200).catch((e) => console.error('[agent-pay] settle', e));
  return { status: r.status, body: r.body, headers: { ...paid.headers, 'x-b1dz-charged': `${charge.priceUsd} ${paid.method}` } };
}

// ── The analyst ────────────────────────────────────────────────────────────

export interface AnalystResult {
  answer: string;
  tier: Tier | 'agent';
  sources: { id: string; title: string; source: string; asOf?: string }[];
  model: string;
  costUsd?: number;
  allowance?: { tier: Tier; monthCostUsd: number; monthCapUsd: number; todayQueries?: number; dailyQueries?: number };
}

const locks = new Map<string, Promise<unknown>>();
/** One analyst call at a time per account, so two parallel calls cannot both slip under the cap. */
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

function analystDeps(): AnalystDeps {
  return {
    search: (q) => researchSearch(q),
    runCard: async (id, params) => {
      const r = await runResearchCard(id, params);
      if (r.status !== 200 || 'error' in r.body) return null;
      const run = r.body as CardRun;
      return { id: run.id, title: run.title, source: run.source, asOf: run.asOf, text: cardAsText(run, 110, 30) };
    },
  };
}

export async function askAnalystFor(
  caller: ResearchCaller,
  req: { headers: Headers },
  input: { question?: unknown; cards?: unknown },
  opts: { fetchImpl?: FetchLike; deps?: AnalystDeps } = {},
): Promise<Outcome<AnalystResult>> {
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (!question) return { status: 400, body: { error: 'question is required' }, headers: {} };
  if (question.length > 2000) return { status: 400, body: { error: 'question is too long (2,000 characters at most)' }, headers: {} };
  const apiKey = (process.env as Record<string, string | undefined>)['ANTHROPIC_API_KEY'] ?? '';
  if (!apiKey) return { status: 503, body: { error: 'The analyst is not configured on this server.' }, headers: {} };
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const deps = opts.deps ?? analystDeps();
  const cfg = monetizationConfig();
  const admin = createAdminSupabase();

  if (caller.kind !== 'user') {
    // Agents pay per query; the price covers the worst-case Opus cost.
    const charge: Charge = { resource: 'research/analyst', priceUsd: cfg.analystPriceUsd, description: 'b1dz AI analyst query' };
    const payer = payerOf(caller);
    const store = await payStore();
    const paid: PayResult = await chargeAgent(req, charge, payer, store);
    if (!paid.ok) return { status: paid.status, body: paid.body, headers: paid.headers };
    try {
      const prepared = await prepareAnalyst({ question, cards: input.cards }, deps);
      const { model } = await analystWorstCase(apiKey, prepared, fetchImpl);
      const a = await callAnalyst(apiKey, model, prepared, fetchImpl);
      await recordUsage(admin, { userId: payer.userId, tier: 'agent', model: a.model, usage: a.usage, costUsd: a.costUsd, agentTokenId: payer.agentTokenId });
      await settleAfter(store, paid, payer, charge, true);
      return { status: 200, body: { answer: a.answer, tier: 'agent', sources: prepared.sources, model: a.model }, headers: paid.headers };
    } catch (e) {
      await settleAfter(store, paid, payer, charge, false).catch(() => undefined);
      console.error('[analyst] agent call failed', (e as Error).message);
      return { status: 502, body: { error: 'The analyst could not answer right now; your payment can be reused for one retry.' }, headers: paid.headers };
    }
  }

  return serialized(caller.userId, async () => {
    const now = Date.now();
    const ent = await getEntitlement(admin, caller.userId, now);
    const [usage, pool] = await Promise.all([userUsage(admin, caller.userId, now), ent.tier === 'free' ? freeGlobalMonthCost(admin, now) : Promise.resolve(0)]);
    const capUsd = ent.tier === 'pro' ? cfg.proMonthlyCapUsd : cfg.freeMonthlyCapUsd;
    const allowanceInfo = {
      tier: ent.tier,
      monthCostUsd: usage.monthCostUsd,
      monthCapUsd: capUsd,
      ...(ent.tier === 'free' ? { todayQueries: usage.todayQueries, dailyQueries: cfg.freeDailyQueries } : {}),
    };
    // Cheap checks first (daily count, caps already reached) before any card runs.
    const early = analystAllowance({ tier: ent.tier, monthCostUsd: usage.monthCostUsd, todayQueries: usage.todayQueries, freeGlobalMonthCostUsd: pool, nextCostUsd: 0 }, cfg);
    if (!early.ok) return { status: early.status, body: { error: early.message, reason: early.reason, allowance: allowanceInfo }, headers: {} };

    const prepared = await prepareAnalyst({ question, cards: input.cards }, deps);
    const { model, worstCaseUsd } = await analystWorstCase(apiKey, prepared, fetchImpl);
    const verdict = analystAllowance({ tier: ent.tier, monthCostUsd: usage.monthCostUsd, todayQueries: usage.todayQueries, freeGlobalMonthCostUsd: pool, nextCostUsd: worstCaseUsd }, cfg);
    if (!verdict.ok) return { status: verdict.status, body: { error: verdict.message, reason: verdict.reason, allowance: allowanceInfo }, headers: {} };

    let a;
    try {
      a = await callAnalyst(apiKey, model, prepared, fetchImpl);
    } catch (e) {
      console.error('[analyst] call failed', (e as Error).message);
      return { status: 502, body: { error: 'The analyst could not answer right now. Try again in a minute.' }, headers: {} };
    }
    await recordUsage(admin, { userId: caller.userId, tier: ent.tier, model: a.model, usage: a.usage, costUsd: a.costUsd });
    const answer = ent.tier === 'free' ? watermark(a.answer) : a.answer;
    return {
      status: 200,
      body: {
        answer,
        tier: ent.tier,
        sources: prepared.sources,
        model: a.model,
        costUsd: Math.round(a.costUsd * 1e4) / 1e4,
        allowance: { ...allowanceInfo, monthCostUsd: usage.monthCostUsd + a.costUsd, ...(ent.tier === 'free' ? { todayQueries: usage.todayQueries + 1 } : {}) },
      },
      headers: {},
    };
  });
}
