/**
 * Agent token logic — the "Coinbase for Agents" sub-account model. Pure,
 * dependency-free helpers (scope checks, symbol allowlist, per-token budget
 * arithmetic) shared by the web API and the daemon. Token generation/hashing
 * (which needs node:crypto) lives in the web layer; this module is the
 * unit-testable policy core.
 */

export type AgentScope = 'read' | 'trade:crypto' | 'trade:equity';
export const AGENT_SCOPES: readonly AgentScope[] = ['read', 'trade:crypto', 'trade:equity'];

export type AgentBudgetWindow = 'daily' | 'weekly' | 'monthly';

export interface AgentTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_suffix: string;
  scopes: string[];
  budget_usd: number | string;
  budget_window: string;
  allowed_symbols: string[] | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export const AGENT_TOKEN_PREFIX = 'b1dz_agent_';

export function isAgentToken(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(AGENT_TOKEN_PREFIX);
}

export function isValidScope(s: string): s is AgentScope {
  return (AGENT_SCOPES as readonly string[]).includes(s);
}

/** Filter arbitrary input down to the known, valid scopes (deduped). */
export function sanitizeScopes(input: unknown): AgentScope[] {
  const arr = Array.isArray(input) ? input : [];
  const out = new Set<AgentScope>();
  for (const s of arr) if (typeof s === 'string' && isValidScope(s)) out.add(s);
  if (out.size === 0) out.add('read');
  return [...out];
}

export function tokenHasScope(row: Pick<AgentTokenRow, 'scopes'>, scope: AgentScope): boolean {
  return Array.isArray(row.scopes) && row.scopes.includes(scope);
}

export function isTokenActive(row: Pick<AgentTokenRow, 'revoked_at'>): boolean {
  return !row.revoked_at;
}

/** True when the token may trade this symbol (empty/null allowlist = any). */
export function symbolAllowed(row: Pick<AgentTokenRow, 'allowed_symbols'>, symbol: string): boolean {
  const list = row.allowed_symbols;
  if (!list || list.length === 0) return true;
  return list.map((s) => s.toUpperCase()).includes(symbol.toUpperCase());
}

export interface AgentBudgetCheck {
  allowed: boolean;
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  reason: string;
}

/**
 * Per-token budget gate. `spentThisWindowUsd` is summed by the caller from
 * crypto_spend_ledger filtered by agent_token_id over the window. A budget of
 * 0 means the token cannot trade at all (read-only by budget).
 */
export function checkAgentBudget(
  row: Pick<AgentTokenRow, 'budget_usd'>,
  spentThisWindowUsd: number,
  orderUsd: number,
): AgentBudgetCheck {
  const budgetUsd = Number(row.budget_usd) || 0;
  const spentUsd = Math.max(0, spentThisWindowUsd);
  const remainingUsd = Math.max(0, budgetUsd - spentUsd);
  if (budgetUsd <= 0) {
    return { allowed: false, budgetUsd, spentUsd, remainingUsd: 0, reason: 'token has no trading budget' };
  }
  if (orderUsd > remainingUsd + 1e-9) {
    return { allowed: false, budgetUsd, spentUsd, remainingUsd, reason: `order $${orderUsd.toFixed(2)} exceeds remaining token budget $${remainingUsd.toFixed(2)}` };
  }
  return { allowed: true, budgetUsd, spentUsd, remainingUsd, reason: 'ok' };
}

/** Start-of-window epoch ms in UTC (matches the engine's spend-budget windows). */
export function agentWindowStart(window: AgentBudgetWindow, now: number): number {
  const d = new Date(now);
  if (window === 'monthly') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (window === 'daily') return dayStart;
  const dow = new Date(dayStart).getUTCDay();
  return dayStart - ((dow + 6) % 7) * 86_400_000;
}
