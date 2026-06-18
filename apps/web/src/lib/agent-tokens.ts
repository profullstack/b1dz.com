/**
 * Agent token web helpers — generation, hashing, and the per-token budget
 * lookup. Server-side only (uses node:crypto + the admin Supabase client).
 * Policy math (scopes, allowlist, budget arithmetic) lives in @b1dz/core.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AGENT_TOKEN_PREFIX, agentWindowStart, type AgentBudgetWindow } from '@b1dz/core';
import { createAdminSupabase } from './supabase';

export function generateAgentToken(): { plaintext: string; hash: string; suffix: string } {
  const plaintext = AGENT_TOKEN_PREFIX + randomBytes(24).toString('base64url');
  return { plaintext, hash: hashAgentToken(plaintext), suffix: plaintext.slice(-4) };
}

export function hashAgentToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Sum this token's spend within the current window from the durable ledger. */
export async function tokenSpentThisWindow(
  tokenId: string,
  window: AgentBudgetWindow,
  now = Date.now(),
): Promise<number> {
  const admin = createAdminSupabase();
  const since = new Date(agentWindowStart(window, now)).toISOString();
  const { data, error } = await admin
    .from('crypto_spend_ledger')
    .select('usd')
    .eq('agent_token_id', tokenId)
    .gte('ts', since);
  if (error) return 0;
  return (data ?? []).reduce((acc: number, r: { usd: number | string }) => acc + Number(r.usd ?? 0), 0);
}
