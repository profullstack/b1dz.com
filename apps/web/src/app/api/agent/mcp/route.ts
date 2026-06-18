import type { NextRequest } from 'next/server';
import { authenticateAgent, type AuthedAgent } from '@/lib/api-auth';
import { getAgentBudget, getAgentPortfolio, getAgentQuote, placeAgentOrder } from '@/lib/agent-trade';

export const dynamic = 'force-dynamic';

/**
 * MCP server (the Base-MCP analog) — exposes b1dz crypto trading to external AI
 * agents (Claude, ChatGPT, any MCP client) as tools, over MCP's JSON-RPC HTTP
 * transport. Auth is the same scoped agent token (Authorization: Bearer
 * b1dz_agent_…); every tool funnels through the shared policy in agent-trade.ts,
 * so trades stay hard-capped by the token's sub-account budget.
 */

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'get_budget',
    description: "Get this agent token's spend budget, amount spent this window, and remaining USD.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_portfolio',
    description: 'Get the current crypto positions and daily P/L for the linked account.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_quote',
    description: 'Get the latest known price for a trading pair (e.g. BTC-USD).',
    inputSchema: {
      type: 'object',
      properties: { pair: { type: 'string', description: 'Trading pair, e.g. BTC-USD' } },
      required: ['pair'],
    },
  },
  {
    name: 'place_order',
    description: 'Place a crypto BUY for the given USD amount, hard-capped by the token budget. Returns accepted/queued; the engine re-checks risk + budget before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        pair: { type: 'string', description: 'Trading pair, e.g. BTC-USD' },
        usd: { type: 'number', description: 'USD notional to buy' },
        exchange: { type: 'string', description: 'Optional exchange hint (kraken|coinbase|binance-us|gemini)' },
        idempotencyKey: { type: 'string', description: 'Optional client key to dedupe retries' },
      },
      required: ['pair', 'usd'],
    },
  },
] as const;

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result });
}
function rpcError(id: unknown, code: number, message: string, httpStatus = 200) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status: httpStatus });
}
function toolText(payload: unknown, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError };
}

async function runTool(agent: AuthedAgent, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'get_budget': return (await getAgentBudget(agent)).body;
    case 'get_portfolio': return (await getAgentPortfolio(agent)).body;
    case 'get_quote': return (await getAgentQuote(agent, String(args.pair ?? ''))).body;
    case 'place_order':
      return (await placeAgentOrder(agent, {
        pair: String(args.pair ?? ''),
        usd: Number(args.usd),
        exchange: typeof args.exchange === 'string' ? args.exchange : undefined,
        idempotencyKey: typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined,
      })).body;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function POST(req: NextRequest) {
  const msg = (await req.json().catch(() => null)) as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> } | null;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id ?? null, -32600, 'invalid JSON-RPC request', 400);
  }

  // `initialize` and notifications don't require auth to negotiate; tool calls do.
  if (msg.method === 'initialize') {
    return rpcResult(msg.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'b1dz-agent', version: '1.0.0' },
    });
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'ping') {
    return msg.id === undefined ? new Response(null, { status: 202 }) : rpcResult(msg.id, {});
  }

  const agent = await authenticateAgent(req);
  if (!agent) return rpcError(msg.id ?? null, -32001, 'unauthorized: provide a valid b1dz_agent_ token', 401);

  if (msg.method === 'tools/list') {
    return rpcResult(msg.id, { tools: TOOLS });
  }
  if (msg.method === 'tools/call') {
    const name = String(msg.params?.name ?? '');
    const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
    try {
      const out = await runTool(agent, name, args);
      return rpcResult(msg.id, toolText(out));
    } catch (e) {
      return rpcResult(msg.id, toolText({ error: (e as Error).message }, true));
    }
  }

  return rpcError(msg.id ?? null, -32601, `method not found: ${msg.method}`);
}
