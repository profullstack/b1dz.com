/**
 * b1dz monetization (plan approved by Anthony 2026-11-25, a 60-day test):
 *
 *   - Agents pay per call in USDC: $0.03 per metered research card (derived
 *     analytics, FRED, EIA; see @b1dz/research billing.ts), $0.35 per AI
 *     analyst query. Raw quotes are never metered.
 *   - Pro is sold as prepaid passes through CoinPay: 30 days for $25, 365 days
 *     for $199. A pass adds `pro_days` to the credit ledger; credit codes and
 *     invites add the same unit. Pro = the AI analyst (Opus) with a hard cap on
 *     what one user's answers may cost us per calendar month (~$8).
 *   - A Profullstack Pass (CoinPay userinfo `pass`) counts as Pro, same cap,
 *     until it expires.
 *   - Free accounts get a small analyst allowance (5/day by default) under a
 *     per-user and a site-wide monthly cost cap, and every free answer carries
 *     a watermark line.
 *
 * Every number here is env-configurable and read at request time (never
 * `process.env.NAME` literally: Next inlines those at build time).
 *
 * Pure functions only; the database side is in entitlements.ts / ai-usage.ts.
 */

const DAY_MS = 86_400_000;

function envRaw(name: string): string | undefined {
  const v = (process.env as Record<string, string | undefined>)[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}
function envNum(name: string, fallback: number): number {
  const v = envRaw(name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface MonetizationConfig {
  /** USD per metered research card call by an agent. */
  cardPriceUsd: number;
  /** USD per AI analyst query by an agent. */
  analystPriceUsd: number;
  pro30PriceUsd: number;
  pro365PriceUsd: number;
  /** Hard cap on one Pro (or Pass) user's Anthropic cost per calendar month (UTC). */
  proMonthlyCapUsd: number;
  /** Free analyst queries per UTC day. */
  freeDailyQueries: number;
  /** Hard cap on one free user's Anthropic cost per calendar month. */
  freeMonthlyCapUsd: number;
  /** Hard cap on all free users together per calendar month. */
  freeGlobalMonthlyCapUsd: number;
  /** Server cost per month, for the 60-day test's break-even line. */
  serverMonthlyUsd: number;
  /** pro_days granted before this date start counting from it: nothing consumed them before Pro existed. */
  proLaunchAt: number;
  testStart: string;
  testEnd: string;
  /** Kill criteria from the plan. */
  maxAiCostPerFreeUserUsd: number;
}

export function monetizationConfig(): MonetizationConfig {
  return {
    cardPriceUsd: envNum('AGENT_CARD_PRICE_USD', 0.03),
    analystPriceUsd: envNum('AGENT_ANALYST_PRICE_USD', 0.35),
    pro30PriceUsd: envNum('PRO_30_PRICE_USD', 25),
    pro365PriceUsd: envNum('PRO_365_PRICE_USD', 199),
    proMonthlyCapUsd: envNum('PRO_AI_MONTHLY_CAP_USD', 8),
    freeDailyQueries: Math.floor(envNum('FREE_ANALYST_DAILY_QUERIES', 5)),
    freeMonthlyCapUsd: envNum('FREE_ANALYST_MONTHLY_CAP_USD', 1),
    freeGlobalMonthlyCapUsd: envNum('FREE_ANALYST_GLOBAL_MONTHLY_CAP_USD', 50),
    serverMonthlyUsd: envNum('B1DZ_SERVER_MONTHLY_USD', 40),
    proLaunchAt: Date.parse(envRaw('PRO_LAUNCH_AT') ?? '2026-11-25T00:00:00Z'),
    testStart: envRaw('MONETIZATION_TEST_START') ?? '2026-11-25',
    testEnd: envRaw('MONETIZATION_TEST_END') ?? '2027-01-24',
    maxAiCostPerFreeUserUsd: envNum('MONETIZATION_MAX_AI_COST_PER_FREE_USER_USD', 5),
  };
}

// ── Pro products (CoinPay hosted checkout) ─────────────────────────────────

export type ProductId = 'pro-30' | 'pro-365' | 'agent-credit-10' | 'agent-credit-50';
export interface Product {
  id: ProductId;
  /** Stored as plugin_invoices.plugin_id so the existing invoice + webhook path settles it. */
  invoiceKey: string;
  label: string;
  priceUsd: number;
  grant: { unit: typeof PRO_DAYS_UNIT; amount: number } | { unit: typeof AGENT_CENTS_UNIT; amount: number };
}

export const PRO_DAYS_UNIT = 'pro_days';
/** Prepaid agent balance, in US cents (credit_ledger unit). */
export const AGENT_CENTS_UNIT = 'agent_cents';
/** plugin_invoices.metadata.b1dz_kind for everything sold here. */
export const PRODUCT_KIND = 'b1dz_product';

export function products(cfg: MonetizationConfig = monetizationConfig()): Product[] {
  return [
    { id: 'pro-30', invoiceKey: 'b1dz:pro-30', label: 'b1dz Pro, 30 days', priceUsd: cfg.pro30PriceUsd, grant: { unit: PRO_DAYS_UNIT, amount: 30 } },
    { id: 'pro-365', invoiceKey: 'b1dz:pro-365', label: 'b1dz Pro, 365 days', priceUsd: cfg.pro365PriceUsd, grant: { unit: PRO_DAYS_UNIT, amount: 365 } },
    { id: 'agent-credit-10', invoiceKey: 'b1dz:agent-credit-10', label: 'b1dz agent credit, $10', priceUsd: 10, grant: { unit: AGENT_CENTS_UNIT, amount: 1000 } },
    { id: 'agent-credit-50', invoiceKey: 'b1dz:agent-credit-50', label: 'b1dz agent credit, $50', priceUsd: 50, grant: { unit: AGENT_CENTS_UNIT, amount: 5000 } },
  ];
}

export function productById(id: unknown, cfg?: MonetizationConfig): Product | null {
  return products(cfg).find((p) => p.id === id) ?? null;
}
export function productByInvoiceKey(key: unknown, cfg?: MonetizationConfig): Product | null {
  return products(cfg).find((p) => p.invoiceKey === key) ?? null;
}

// ── Pro days -> Pro until ──────────────────────────────────────────────────

export interface LedgerLike {
  amount: number;
  kind: 'grant' | 'spend';
  at: number;
}

/**
 * When Pro runs out, from the pro_days ledger. Days run from the moment they
 * were granted and stack: a grant while Pro is active extends the end, a
 * grant after it lapsed starts fresh. Grants made before Pro existed
 * (credit codes and invites since 2026-10-26, which nothing consumed) start at
 * the launch date. Spends, if any are ever recorded, shorten the end.
 */
export function proUntilFromLedger(entries: LedgerLike[], launchAt: number): number {
  let until = 0;
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    const days = Number(e.amount) || 0;
    if (days <= 0) continue;
    if (e.kind === 'grant') {
      const start = Math.max(e.at, launchAt, until);
      until = start + days * DAY_MS;
    } else {
      until = Math.max(0, until - days * DAY_MS);
    }
  }
  return until;
}

export type Tier = 'pro' | 'free';
export interface Entitlement {
  tier: Tier;
  /** 'pass' when only a Profullstack Pass makes this account Pro. */
  via: 'pro_days' | 'pass' | null;
  proUntil: number | null;
  passUntil: number | null;
}

export function resolveEntitlement(input: { proUntil: number; pass: { active: boolean; expiresAt: number | null } | null }, now: number): Entitlement {
  const proActive = input.proUntil > now;
  const passUntil = input.pass?.active && input.pass.expiresAt && input.pass.expiresAt > now ? input.pass.expiresAt : null;
  if (proActive) return { tier: 'pro', via: 'pro_days', proUntil: input.proUntil, passUntil };
  if (passUntil) return { tier: 'pro', via: 'pass', proUntil: null, passUntil };
  return { tier: 'free', via: null, proUntil: input.proUntil || null, passUntil: null };
}

// ── Anthropic cost ─────────────────────────────────────────────────────────

/** USD per million tokens. Unknown Opus ids are priced at the higher previous-generation rate, never below cost. */
const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /^claude-opus-5-5/, input: 4, output: 20 },
  { match: /^claude-opus/, input: 5, output: 25 },
  { match: /^claude-sonnet-5/, input: 2, output: 10 },
  { match: /^claude-sonnet/, input: 3, output: 15 },
  { match: /^claude-haiku-5-5/, input: 0.1, output: 0.5 },
  { match: /^claude-haiku/, input: 1, output: 5 },
  { match: /^claude-(fable|mythos)/, input: 10, output: 50 },
];

export function modelPrice(model: string): { input: number; output: number } {
  return PRICES.find((p) => p.match.test(model)) ?? { input: 10, output: 50 };
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** What one Messages call cost, from its usage block: cache writes 1.25x, cache reads 0.1x input. */
export function usageCostUsd(model: string, u: Usage): number {
  const p = modelPrice(model);
  const input = (u.input_tokens ?? 0) * p.input + (u.cache_creation_input_tokens ?? 0) * p.input * 1.25 + (u.cache_read_input_tokens ?? 0) * p.input * 0.1;
  return (input + (u.output_tokens ?? 0) * p.output) / 1_000_000;
}

/** The most a call can cost: every prompt character a token, every output token used. Used to refuse before a cap is crossed. */
export function worstCaseCostUsd(model: string, promptChars: number, maxTokens: number): number {
  const p = modelPrice(model);
  return (Math.ceil(promptChars / 2.5) * p.input + maxTokens * p.output) / 1_000_000;
}

// ── Analyst allowance ──────────────────────────────────────────────────────

export const FREE_WATERMARK = 'Free b1dz analyst. Upgrade to Pro for unlimited (capped) answers: b1dz.com/pricing';

export function watermark(answer: string): string {
  return `${answer.trimEnd()}\n\n— ${FREE_WATERMARK}`;
}

export interface AllowanceInput {
  tier: Tier;
  /** This user's Anthropic cost this calendar month. */
  monthCostUsd: number;
  /** This user's analyst queries today (UTC). */
  todayQueries: number;
  /** All free users' cost this calendar month. */
  freeGlobalMonthCostUsd: number;
  /** The worst case this call could add. */
  nextCostUsd: number;
}

export type AllowanceDecision = { ok: true } | { ok: false; status: 402 | 429; reason: 'pro_cap' | 'free_daily' | 'free_cap' | 'free_pool'; message: string };

export function analystAllowance(i: AllowanceInput, cfg: MonetizationConfig): AllowanceDecision {
  const month = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  if (i.tier === 'pro') {
    if (i.monthCostUsd + i.nextCostUsd > cfg.proMonthlyCapUsd) {
      return {
        ok: false,
        status: 429,
        reason: 'pro_cap',
        message: `You have used this month's Pro analyst allowance ($${cfg.proMonthlyCapUsd.toFixed(2)} of AI cost in ${month}). It resets on the 1st (UTC).`,
      };
    }
    return { ok: true };
  }
  if (i.todayQueries >= cfg.freeDailyQueries) {
    return {
      ok: false,
      status: 429,
      reason: 'free_daily',
      message: `Free accounts get ${cfg.freeDailyQueries} analyst questions a day, and you have used them. Pro (from $${cfg.pro30PriceUsd}) answers more: b1dz.com/pricing`,
    };
  }
  if (i.monthCostUsd + i.nextCostUsd > cfg.freeMonthlyCapUsd) {
    return { ok: false, status: 402, reason: 'free_cap', message: `You have used this month's free analyst allowance. Pro answers more: b1dz.com/pricing` };
  }
  if (i.freeGlobalMonthCostUsd + i.nextCostUsd > cfg.freeGlobalMonthlyCapUsd) {
    return { ok: false, status: 402, reason: 'free_pool', message: 'The free analyst is out of capacity for this month. Pro answers are unaffected: b1dz.com/pricing' };
  }
  return { ok: true };
}

export function monthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
export function dayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ── 60-day test metrics ────────────────────────────────────────────────────

export interface MetricsInput {
  freeAiCostUsd: number;
  freeActiveUsers: number;
  proAiCostUsd: number;
  agentAiCostUsd: number;
  proRevenueUsd: number;
  agentCreditRevenueUsd: number;
  x402RevenueUsd: number;
  renewals: number;
  proBuyers: number;
}

export function testVerdict(m: MetricsInput, cfg: MonetizationConfig) {
  const totalAiCost = m.freeAiCostUsd + m.proAiCostUsd + m.agentAiCostUsd;
  const costPerFreeUser = m.freeActiveUsers > 0 ? m.freeAiCostUsd / m.freeActiveUsers : 0;
  const revenue = m.proRevenueUsd + m.agentCreditRevenueUsd + m.x402RevenueUsd;
  const cost = totalAiCost + cfg.serverMonthlyUsd;
  return {
    totalAiCost,
    costPerFreeUser,
    revenue,
    cost,
    freeCostRed: costPerFreeUser > cfg.maxAiCostPerFreeUserUsd,
    revenueRed: m.proRevenueUsd < totalAiCost + cfg.serverMonthlyUsd,
    allRevenueRed: revenue < cost,
  };
}

/** Admins: B1DZ_ADMIN_USER_IDS (comma list of auth user ids, set by hand in app.env). */
export function isAdminUser(userId: string | null | undefined): boolean {
  if (!userId) return false;
  const ids = (envRaw('B1DZ_ADMIN_USER_IDS') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return ids.includes(userId.toLowerCase());
}
