/**
 * Stock orders for agents (MCP), through the user's own linked broker.
 *
 * An agent gets less than the signed-in user does at the terminal:
 *
 *   - the token needs the `trade:equity` scope (an OAuth connection is
 *     read-only unless the user grants more; a b1dz_agent_ key is scoped on
 *     /settings);
 *   - the symbol must be on the token's allowlist, when it has one;
 *   - a BUY must have a known maximum cost: a dollar amount, or a limit order
 *     (shares x limit price). A market order by share count is refused,
 *     because its cost is unknown until it fills;
 *   - that cost is charged to the token's budget (the same budget and ledger
 *     crypto buys use) BEFORE the order is sent, and released if the broker
 *     refuses it. A budget of 0 means the token cannot buy;
 *   - a broker warning that needs a human yes is never answered for them.
 *
 * Everything the terminal ticket enforces still applies after that, in the
 * daemon: an unlocked session, no selling more than held, the live-order cap.
 */
import { checkAgentBudget, describeOrder, parseManualOrder, symbolAllowed, tokenHasScope, type AgentBudgetWindow } from '@b1dz/core';
import { tokenSpentThisWindow } from './agent-tokens';
import type { AuthedAgent } from './api-auth';
import { daemonEquity } from './daemon-control';

export interface AgentEquityResult {
  status: number;
  body: Record<string, unknown>;
}

const BROKER_ID = /^[a-z]{2,20}$/;
const brokerOf = (v: unknown): string | undefined => (typeof v === 'string' && BROKER_ID.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : undefined);

async function logAction(agent: AuthedAgent, action: string, detail: Record<string, unknown>, ok: boolean) {
  try {
    await agent.admin.from('agent_actions').insert({ user_id: agent.userId, agent_token_id: agent.tokenId, action, detail, ok });
  } catch {
    /* non-fatal */
  }
}

/** Linked brokers, buying power, positions and orders. Read-only. */
export async function getAgentBrokerAccount(agent: AuthedAgent, broker?: unknown): Promise<AgentEquityResult> {
  const b = brokerOf(broker);
  return daemonEquity('account', agent.userId, b ? { broker: b } : {});
}

export async function placeAgentStockOrder(agent: AuthedAgent, input: Record<string, unknown>): Promise<AgentEquityResult> {
  if (!tokenHasScope(agent.token, 'trade:equity')) {
    await logAction(agent, 'place_stock_order', { reason: 'missing trade:equity scope' }, false);
    return { status: 403, body: { error: 'this connection cannot trade stocks: it lacks the trade:equity scope. The user can place the order at b1dz.com/terminal.' } };
  }
  const parsed = parseManualOrder(input);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const order = parsed.order;
  if (!symbolAllowed(agent.token, order.symbol)) {
    await logAction(agent, 'place_stock_order', { symbol: order.symbol, reason: 'symbol not in allowlist' }, false);
    return { status: 403, body: { error: `${order.symbol} is not in this token's allowed symbols` } };
  }
  const broker = brokerOf(input.broker);

  let reservedId: string | null = null;
  let usd = 0;
  if (order.side === 'buy') {
    usd = order.notionalUsd ?? (order.limitPrice != null && order.qty != null ? order.qty * order.limitPrice : 0);
    if (!usd) {
      return { status: 400, body: { error: 'a buy needs a known maximum cost: give notionalUsd (a dollar amount), or a limit order with qty and limitPrice' } };
    }
    const window = (agent.token.budget_window as AgentBudgetWindow) ?? 'daily';
    const budget = checkAgentBudget(agent.token, await tokenSpentThisWindow(agent.tokenId, window), usd);
    if (!budget.allowed) {
      await logAction(agent, 'place_stock_order', { symbol: order.symbol, usd, reason: budget.reason }, false);
      return { status: 402, body: { error: budget.reason, remainingUsd: budget.remainingUsd } };
    }
    // Reserve first: two requests in the same instant cannot both pass on the same remaining budget.
    const { data, error } = await agent.admin
      .from('crypto_spend_ledger')
      .insert({ user_id: agent.userId, source: 'agent', exchange: broker ?? 'broker', pair: order.symbol, usd, agent_token_id: agent.tokenId })
      .select('id')
      .single();
    if (error || !data) return { status: 500, body: { error: 'could not reserve budget for this order; nothing was sent' } };
    reservedId = String((data as { id: string }).id);
  }
  const release = async () => {
    if (reservedId) await agent.admin.from('crypto_spend_ledger').delete().eq('id', reservedId);
  };

  const r = await daemonEquity('order', agent.userId, { ...order, ...(broker ? { broker } : {}) });
  const result = r.body.result as { ok?: boolean; message?: string; needsConfirm?: unknown; orderId?: string; status?: string } | undefined;

  if (r.body.unknown) {
    // Timed out after sending: the order may exist, so the budget stays charged.
    await logAction(agent, 'place_stock_order', { order: describeOrder(order), usd, outcome: 'unknown (broker timeout)' }, false);
    return { status: 504, body: { error: 'The broker did not answer in time. The order may or may not have been placed: read broker_account before sending it again.' } };
  }
  if (result?.needsConfirm) {
    await release();
    await logAction(agent, 'place_stock_order', { order: describeOrder(order), reason: 'broker asked for confirmation' }, false);
    return { status: 409, body: { error: `The broker wants a person to confirm this order (${result.message ?? 'warning'}). Nothing was sent. The user can place it at b1dz.com/terminal.` } };
  }
  if (r.status !== 200 || !result?.ok) {
    await release();
    const error = String(r.body.error ?? result?.message ?? `order refused (${r.status})`);
    await logAction(agent, 'place_stock_order', { order: describeOrder(order), reason: error.slice(0, 200) }, false);
    return { status: r.status === 200 ? 422 : r.status, body: { error, locked: r.body.locked === true || undefined } };
  }

  await logAction(agent, 'place_stock_order', { order: describeOrder(order), usd, broker: r.body.broker, paper: r.body.paper, orderId: result.orderId }, true);
  return {
    status: 200,
    body: { placed: describeOrder(order), broker: r.body.broker, paper: r.body.paper, orderId: result.orderId, status: result.status, chargedToBudgetUsd: usd || undefined },
  };
}

export async function cancelAgentStockOrder(agent: AuthedAgent, input: Record<string, unknown>): Promise<AgentEquityResult> {
  if (!tokenHasScope(agent.token, 'trade:equity')) return { status: 403, body: { error: 'this connection cannot trade stocks: it lacks the trade:equity scope' } };
  const orderId = typeof input.orderId === 'string' ? input.orderId.trim() : '';
  if (!orderId || orderId.length > 128) return { status: 400, body: { error: 'orderId required (see broker_account)' } };
  const broker = brokerOf(input.broker);
  const r = await daemonEquity('cancel', agent.userId, { orderId, ...(broker ? { broker } : {}) });
  await logAction(agent, 'cancel_stock_order', { orderId }, r.status === 200);
  return r.status === 200 ? { status: 200, body: { canceled: orderId, broker: r.body.broker } } : { status: r.status, body: { error: String(r.body.error ?? 'cancel refused') } };
}
