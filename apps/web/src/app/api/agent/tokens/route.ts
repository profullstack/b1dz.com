import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { generateAgentToken } from '@/lib/agent-tokens';
import { sanitizeScopes } from '@b1dz/core';

export const dynamic = 'force-dynamic';

/** List the current user's agent tokens (never returns the plaintext or hash). */
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { data, error } = await auth.client
    .from('agent_tokens')
    .select('id, name, token_suffix, scopes, budget_usd, budget_window, allowed_symbols, revoked_at, last_used_at, created_at')
    .order('created_at', { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ tokens: data ?? [] });
}

/**
 * Create a new agent token. The plaintext is returned ONCE here and never
 * again — only its sha-256 hash is stored. The caller copies it into their
 * agent/MCP client.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const body = (await req.json().catch(() => null)) as {
    name?: unknown;
    scopes?: unknown;
    budgetUsd?: unknown;
    budgetWindow?: unknown;
    allowedSymbols?: unknown;
  } | null;

  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'agent';
  const scopes = sanitizeScopes(body?.scopes);
  const budgetUsd = Number(body?.budgetUsd);
  const budgetWindow = ['daily', 'weekly', 'monthly'].includes(String(body?.budgetWindow)) ? String(body?.budgetWindow) : 'daily';
  const allowedSymbols = Array.isArray(body?.allowedSymbols)
    ? body.allowedSymbols.filter((s): s is string => typeof s === 'string').map((s) => s.toUpperCase())
    : null;

  const { plaintext, hash, suffix } = generateAgentToken();
  const { data, error } = await auth.client
    .from('agent_tokens')
    .insert({
      user_id: auth.userId,
      name,
      token_hash: hash,
      token_suffix: suffix,
      scopes,
      budget_usd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : 0,
      budget_window: budgetWindow,
      allowed_symbols: allowedSymbols && allowedSymbols.length > 0 ? allowedSymbols : null,
    })
    .select('id, name, token_suffix, scopes, budget_usd, budget_window, allowed_symbols, created_at')
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // token returned exactly once
  return Response.json({ token: plaintext, record: data });
}
