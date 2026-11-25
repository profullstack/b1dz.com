/**
 * Who is Pro, and what their AI analyst use has cost (server only).
 *
 * Pro comes from two places and nothing else:
 *   - pro_days in the credit ledger (CoinPay passes, credit codes, invites),
 *     turned into an end date by proUntilFromLedger;
 *   - a Profullstack Pass, read from CoinPay userinfo when the user signs in
 *     with CoinPay or connects it from Settings (bound by CoinPay sub only),
 *     stored on coinpay_identities and honoured until its expires_at.
 *
 * Usage rows (ai_usage) carry the real token cost of every analyst call; the
 * Pro cap and the free allowance are sums over them.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getCreditDeps, type CreditDeps } from './credits';
import {
  AGENT_CENTS_UNIT,
  PRO_DAYS_UNIT,
  dayStart,
  monetizationConfig,
  monthStart,
  proUntilFromLedger,
  resolveEntitlement,
  type Entitlement,
  type Tier,
} from './monetization';

type Db = Pick<SupabaseClient, 'from'>;

export interface PassRow {
  active: boolean;
  expiresAt: number | null;
}

export async function readPass(db: Db, userId: string): Promise<PassRow | null> {
  const { data, error } = await db.from('coinpay_identities').select('pass_active, pass_expires_at').eq('user_id', userId).maybeSingle();
  if (error || !data) return null;
  const row = data as { pass_active: boolean | null; pass_expires_at: string | null };
  return { active: !!row.pass_active, expiresAt: row.pass_expires_at ? Date.parse(row.pass_expires_at) : null };
}

/** Store what CoinPay said about the pass at this sign-in or connect. */
export async function savePass(db: Db, userId: string, pass: { active: boolean; expiresAt: Date | null }): Promise<void> {
  await db
    .from('coinpay_identities')
    .update({
      pass_active: pass.active && !!pass.expiresAt,
      pass_expires_at: pass.active && pass.expiresAt ? pass.expiresAt.toISOString() : null,
      pass_checked_at: new Date().toISOString(),
    })
    .eq('user_id', userId);
}

export async function proUntil(userId: string, deps?: CreditDeps): Promise<number> {
  const d = deps ?? (await getCreditDeps());
  const entries = await d.credits.history(userId, PRO_DAYS_UNIT);
  return proUntilFromLedger(entries, monetizationConfig().proLaunchAt);
}

export async function getEntitlement(db: Db, userId: string, now = Date.now(), deps?: CreditDeps): Promise<Entitlement> {
  const [until, pass] = await Promise.all([proUntil(userId, deps), readPass(db, userId)]);
  return resolveEntitlement({ proUntil: until, pass }, now);
}

export async function agentBalanceCents(userId: string, deps?: CreditDeps): Promise<number> {
  const d = deps ?? (await getCreditDeps());
  return d.credits.balance(userId, AGENT_CENTS_UNIT);
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface UsageSummary {
  monthCostUsd: number;
  todayQueries: number;
}

export async function userUsage(db: Db, userId: string, now = Date.now()): Promise<UsageSummary> {
  const { data, error } = await db.from('ai_usage').select('at, cost_usd').eq('user_id', userId).gte('at', iso(monthStart(now)));
  if (error) throw new Error(`ai_usage read: ${error.message}`);
  const rows = (data ?? []) as { at: string; cost_usd: number | string }[];
  const today = dayStart(now);
  return {
    monthCostUsd: rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0),
    todayQueries: rows.filter((r) => Date.parse(r.at) >= today).length,
  };
}

export async function freeGlobalMonthCost(db: Db, now = Date.now()): Promise<number> {
  const { data, error } = await db.from('ai_usage').select('cost_usd').eq('tier', 'free').gte('at', iso(monthStart(now)));
  if (error) throw new Error(`ai_usage read: ${error.message}`);
  return ((data ?? []) as { cost_usd: number | string }[]).reduce((s, r) => s + Number(r.cost_usd || 0), 0);
}

export interface UsageRecord {
  userId: string | null;
  tier: Tier | 'agent';
  model: string;
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  costUsd: number;
  agentTokenId?: string | null;
}

export async function recordUsage(db: Db, r: UsageRecord): Promise<void> {
  const { error } = await db.from('ai_usage').insert({
    user_id: r.userId,
    tier: r.tier,
    model: r.model,
    input_tokens: r.usage.input_tokens ?? 0,
    output_tokens: r.usage.output_tokens ?? 0,
    cache_read_tokens: r.usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: r.usage.cache_creation_input_tokens ?? 0,
    cost_usd: Math.round(r.costUsd * 1e6) / 1e6,
    agent_token_id: r.agentTokenId ?? null,
  });
  if (error) console.error('[ai-usage] record failed', error.message);
}
