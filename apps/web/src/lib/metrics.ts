/**
 * The 60-day monetization test (2026-11-25 to 2027-01-24), trailing 30 days.
 *
 * Revisit triggers from the plan: AI cost per non-paying user above $5/month,
 * founder time on b1dz above 3 hours a week (not measurable: a note field),
 * or prepaid renewals not covering Anthropic plus server cost.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { monetizationConfig, testVerdict, type MetricsInput } from './monetization';

type Db = Pick<SupabaseClient, 'from'>;
const DAY_MS = 86_400_000;

export interface InvoiceLite {
  user_id: string;
  plugin_id: string;
  amount_usd: number | string;
  paid_at: string;
}

/** Pure: invoices + usage rows -> the numbers on the admin page. */
export function computeMetrics(input: {
  since: number;
  usage: { user_id: string | null; tier: string; cost_usd: number | string }[];
  invoices: InvoiceLite[];
  charges: { method: string; amount_usd: number | string }[];
}): MetricsInput & { prepaidSpendUsd: number } {
  const num = (v: number | string) => Number(v) || 0;
  const freeRows = input.usage.filter((u) => u.tier === 'free');
  const paidPro = input.invoices.filter((i) => i.plugin_id.startsWith('b1dz:pro-')).sort((a, b) => Date.parse(a.paid_at) - Date.parse(b.paid_at));
  const inWindow = (i: InvoiceLite) => Date.parse(i.paid_at) >= input.since;
  const seen = new Set<string>();
  let renewals = 0;
  for (const inv of paidPro) {
    if (seen.has(inv.user_id) && inWindow(inv)) renewals++;
    seen.add(inv.user_id);
  }
  const proWindow = paidPro.filter(inWindow);
  return {
    freeAiCostUsd: freeRows.reduce((s, r) => s + num(r.cost_usd), 0),
    freeActiveUsers: new Set(freeRows.map((r) => r.user_id).filter(Boolean)).size,
    proAiCostUsd: input.usage.filter((u) => u.tier === 'pro').reduce((s, r) => s + num(r.cost_usd), 0),
    agentAiCostUsd: input.usage.filter((u) => u.tier === 'agent').reduce((s, r) => s + num(r.cost_usd), 0),
    proRevenueUsd: proWindow.reduce((s, i) => s + num(i.amount_usd), 0),
    proBuyers: new Set(proWindow.map((i) => i.user_id)).size,
    renewals,
    agentCreditRevenueUsd: input.invoices.filter((i) => i.plugin_id.startsWith('b1dz:agent-credit-') && inWindow(i)).reduce((s, i) => s + num(i.amount_usd), 0),
    x402RevenueUsd: input.charges.filter((c) => c.method === 'x402').reduce((s, c) => s + num(c.amount_usd), 0),
    prepaidSpendUsd: input.charges.filter((c) => c.method === 'prepaid').reduce((s, c) => s + num(c.amount_usd), 0),
  };
}

export async function loadMetrics(db: Db, now = Date.now()) {
  const cfg = monetizationConfig();
  const since = now - 30 * DAY_MS;
  const sinceIso = new Date(since).toISOString();
  const [usage, invoices, charges, notes, payingUsers] = await Promise.all([
    db.from('ai_usage').select('user_id, tier, cost_usd').gte('at', sinceIso).limit(100_000),
    // All paid b1dz products ever: renewals need the earlier purchase too.
    db.from('plugin_invoices').select('user_id, plugin_id, amount_usd, paid_at').like('plugin_id', 'b1dz:%').not('paid_at', 'is', null).limit(100_000),
    db.from('agent_charges').select('method, amount_usd').gte('at', sinceIso).limit(100_000),
    db.from('monetization_notes').select('at, note').order('at', { ascending: false }).limit(10),
    db.from('coinpay_identities').select('user_id', { count: 'exact', head: true }).eq('pass_active', true).gt('pass_expires_at', new Date(now).toISOString()),
  ]);
  for (const r of [usage, invoices, charges]) if (r.error) throw new Error(r.error.message);
  const m = computeMetrics({
    since,
    usage: (usage.data ?? []) as never,
    invoices: (invoices.data ?? []) as never,
    charges: (charges.data ?? []) as never,
  });
  return {
    config: cfg,
    windowStart: sinceIso,
    metrics: m,
    verdict: testVerdict(m, cfg),
    activePasses: payingUsers.count ?? 0,
    notes: (notes.data ?? []) as { at: string; note: string }[],
  };
}
