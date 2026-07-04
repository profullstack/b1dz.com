/**
 * Agent trading + read helpers. Every agent action funnels through here so the
 * REST route and the MCP server enforce the SAME policy: scope → symbol
 * allowlist → per-token budget → enqueue for the daemon → audit log. Order
 * EXECUTION happens in the daemon (which re-applies the engine's own spend
 * budget + risk guards); this layer authorizes and enqueues.
 */
import {
  checkAgentBudget,
  symbolAllowed,
  tokenHasScope,
  type AgentBudgetWindow,
} from '@b1dz/core';
import { tokenSpentThisWindow } from './agent-tokens';
import type { AuthedAgent } from './api-auth';

export interface AgentOrderRequest {
  pair: string;
  exchange?: string;
  usd: number;
  idempotencyKey?: string;
}

export interface AgentOrderResult {
  status: number;
  body: Record<string, unknown>;
}

async function logAction(agent: AuthedAgent, action: string, detail: Record<string, unknown>, ok: boolean) {
  try {
    await agent.admin.from('agent_actions').insert({
      user_id: agent.userId,
      agent_token_id: agent.tokenId,
      action,
      detail,
      ok,
    });
  } catch { /* non-fatal */ }
}

/** This token's queued-but-not-yet-executed orders (not in crypto_spend_ledger yet). */
async function pendingQueue(agent: AuthedAgent): Promise<AgentQueueItem[]> {
  const { data } = await agent.admin
    .from('source_state')
    .select('payload')
    .eq('user_id', agent.userId)
    .eq('source_id', 'agent-orders')
    .maybeSingle();
  const queue = ((data?.payload as { queue?: AgentQueueItem[] } | undefined)?.queue ?? []) as AgentQueueItem[];
  return queue;
}

function pendingUsdFor(queue: AgentQueueItem[], tokenId: string): number {
  return queue.filter((q) => q.tokenId === tokenId).reduce((acc, q) => acc + Number(q.usd ?? 0), 0);
}

export async function getAgentBudget(agent: AuthedAgent): Promise<AgentOrderResult> {
  const window = (agent.token.budget_window as AgentBudgetWindow) ?? 'daily';
  const spent = await tokenSpentThisWindow(agent.tokenId, window);
  const queue = await pendingQueue(agent);
  const pendingUsd = pendingUsdFor(queue, agent.tokenId);
  const check = checkAgentBudget(agent.token, spent + pendingUsd, 0);
  return {
    status: 200,
    body: {
      budgetUsd: check.budgetUsd,
      spentUsd: check.spentUsd,
      remainingUsd: check.remainingUsd,
      window,
      scopes: agent.scopes,
      allowedSymbols: agent.token.allowed_symbols ?? null,
    },
  };
}

async function readCryptoState(agent: AuthedAgent): Promise<Record<string, unknown> | null> {
  const { data } = await agent.admin
    .from('source_state')
    .select('payload')
    .eq('user_id', agent.userId)
    .eq('source_id', 'crypto-trade')
    .maybeSingle();
  return (data?.payload as Record<string, unknown>) ?? null;
}

export async function getAgentPortfolio(agent: AuthedAgent): Promise<AgentOrderResult> {
  const payload = await readCryptoState(agent);
  const trade = (payload?.trade ?? payload) as Record<string, unknown> | undefined;
  return {
    status: 200,
    body: {
      positions: (trade?.positions as unknown[]) ?? [],
      dailyPnl: trade?.dailyPnl ?? null,
      dailyPnlPct: trade?.dailyPnlPct ?? null,
    },
  };
}

export async function getAgentQuote(agent: AuthedAgent, pair: string): Promise<AgentOrderResult> {
  if (!pair) return { status: 400, body: { error: 'pair required' } };
  const payload = await readCryptoState(agent);
  const trade = (payload?.trade ?? payload) as { positions?: Array<{ pair: string; exchange: string; currentPrice: number }> } | undefined;
  const pos = (trade?.positions ?? []).find((p) => p.pair.toUpperCase() === pair.toUpperCase());
  if (!pos) return { status: 404, body: { error: `no live price for ${pair} (not in active set)`, pair } };
  return { status: 200, body: { pair: pos.pair, exchange: pos.exchange, price: pos.currentPrice } };
}

/**
 * Authorize + enqueue a BUY for the daemon. Enforces scope, symbol allowlist,
 * and the per-token budget. Idempotent on `idempotencyKey` within the queue.
 */
export async function placeAgentOrder(agent: AuthedAgent, req: AgentOrderRequest): Promise<AgentOrderResult> {
  if (!tokenHasScope(agent.token, 'trade:crypto')) {
    await logAction(agent, 'place_order', { reason: 'missing trade:crypto scope' }, false);
    return { status: 403, body: { error: 'token lacks trade:crypto scope' } };
  }
  const pair = String(req.pair ?? '').toUpperCase();
  const usd = Number(req.usd);
  if (!pair || !Number.isFinite(usd) || usd <= 0) {
    return { status: 400, body: { error: 'pair and positive usd are required' } };
  }
  if (!symbolAllowed(agent.token, pair)) {
    await logAction(agent, 'place_order', { pair, reason: 'symbol not in allowlist' }, false);
    return { status: 403, body: { error: `${pair} is not in this token's allowed symbols` } };
  }

  // Read the pending queue BEFORE the budget check. tokenSpentThisWindow only
  // reflects orders the daemon has already executed and ledgered — orders
  // this token already has enqueued-but-not-yet-executed are invisible to it,
  // so without counting them here, N rapid requests submitted before the
  // daemon's next tick would each see the same stale `spent` and all pass,
  // letting the token's real committed spend exceed budget_usd by up to N×.
  const queue = await pendingQueue(agent);
  const key = req.idempotencyKey ?? `${agent.tokenId}:${Date.now()}`;
  if (queue.some((q) => q.idempotencyKey === key)) {
    return { status: 200, body: { status: 'accepted', idempotencyKey: key, duplicate: true } };
  }

  const window = (agent.token.budget_window as AgentBudgetWindow) ?? 'daily';
  const spent = await tokenSpentThisWindow(agent.tokenId, window);
  const pendingUsd = pendingUsdFor(queue, agent.tokenId);
  const budget = checkAgentBudget(agent.token, spent + pendingUsd, usd);
  if (!budget.allowed) {
    await logAction(agent, 'place_order', { pair, usd, reason: budget.reason }, false);
    return { status: 402, body: { error: budget.reason, remainingUsd: budget.remainingUsd } };
  }
  const item: AgentQueueItem = {
    idempotencyKey: key,
    tokenId: agent.tokenId,
    pair,
    exchange: req.exchange ?? null,
    usd,
    side: 'buy',
    enqueuedAt: new Date().toISOString(),
  };
  // keep the queue bounded
  const nextQueue = [...queue.slice(-49), item];
  const { error } = await agent.admin.from('source_state').upsert(
    { user_id: agent.userId, source_id: 'agent-orders', payload: { queue: nextQueue }, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,source_id' },
  );
  if (error) return { status: 500, body: { error: error.message } };

  await logAction(agent, 'place_order', { pair, usd, idempotencyKey: key, remainingUsd: budget.remainingUsd - usd }, true);
  return {
    status: 202,
    body: { status: 'accepted', idempotencyKey: key, pair, usd, remainingBudgetUsd: budget.remainingUsd - usd, note: 'queued for execution; the engine re-checks risk + budget before placing' },
  };
}

export interface AgentQueueItem {
  idempotencyKey: string;
  tokenId: string;
  pair: string;
  exchange: string | null;
  usd: number;
  side: 'buy';
  enqueuedAt: string;
}
