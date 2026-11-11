import type { NextRequest } from 'next/server';
import { authenticateAgent, type AuthedAgent } from '@/lib/api-auth';
import { ACCESS_PREFIX, CORS_HEADERS, resolveAccessToken, resourceMetadataUrl, SCOPE } from '@/lib/mcp-oauth';
import { createAdminSupabase } from '@/lib/supabase';
import { getAgentBudget, getAgentPortfolio, getAgentQuote, placeAgentOrder } from '@/lib/agent-trade';

export const dynamic = 'force-dynamic';

/**
 * MCP server (the Base-MCP analog) — exposes b1dz crypto trading to external AI
 * agents (Claude, ChatGPT, any MCP client) as tools, over MCP's JSON-RPC HTTP
 * transport. Auth: a scoped agent token (Authorization: Bearer b1dz_agent_…) or
 * an OAuth 2.1 access token (b1dz_oat_…, see lib/mcp-oauth.ts) whose grant is
 * backed by its own agent token. Either way every tool funnels through the
 * shared policy in agent-trade.ts, so trades stay hard-capped by that
 * sub-account's budget.
 *
 * Any request without a valid credential is HTTP 401 with
 * `WWW-Authenticate: Bearer resource_metadata=…` (MCP authorization spec), so
 * connector UIs (claude.ai, ChatGPT) start OAuth on the first request.
 */

/** Newest first; an initialize asking for one of these gets it back, anything else gets the newest. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const TOOLS = [
  {
    name: 'get_budget',
    title: 'Get agent budget',
    description: "Get this agent token's spend budget, amount spent this window, and remaining USD.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Get agent budget', ...READ },
  },
  {
    name: 'get_portfolio',
    title: 'Get portfolio',
    description: 'Get the current crypto positions and daily P/L for the linked account.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Get portfolio', ...READ },
  },
  {
    name: 'get_quote',
    title: 'Get quote',
    description: 'Get the latest known price for a trading pair (e.g. BTC-USD).',
    inputSchema: {
      type: 'object',
      properties: { pair: { type: 'string', description: 'Trading pair, e.g. BTC-USD' } },
      required: ['pair'],
    },
    annotations: { title: 'Get quote', ...READ },
  },
  {
    name: 'place_order',
    title: 'Place crypto buy',
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
    // Spends real money on an exchange: not read-only, not undoable, reaches outside b1dz.
    annotations: { title: 'Place crypto buy', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
] as const;

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: CORS_HEADERS });
}
function rpcError(id: unknown, code: number, message: string, httpStatus = 200) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status: httpStatus, headers: CORS_HEADERS });
}

/** 401 + the RFC 9728 pointer; `invalid_token` when a credential was sent but did not resolve. */
function challenge(id: unknown, presented: boolean) {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl()}"`, `scope="${SCOPE}"`];
  if (presented) parts.push('error="invalid_token"', 'error_description="The access token is invalid or expired"');
  return Response.json(
    { jsonrpc: '2.0', id, error: { code: -32001, message: 'unauthorized: sign in with OAuth or provide a valid b1dz_agent_ token' } },
    { status: 401, headers: { ...CORS_HEADERS, 'www-authenticate': parts.join(', '), 'cache-control': 'no-store' } },
  );
}

function bearer(req: NextRequest): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec((req.headers.get('authorization') ?? '').trim());
  return m ? m[1] : null;
}

/** OAuth access token or b1dz_agent_ key; both resolve to the same AuthedAgent shape. */
async function principal(req: NextRequest, token: string): Promise<AuthedAgent | null> {
  if (token.startsWith(ACCESS_PREFIX)) return resolveAccessToken(createAdminSupabase(), token);
  return authenticateAgent(req);
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
  const token = bearer(req);
  const agent = token ? await principal(req, token) : null;
  const msg = (await req.json().catch(() => null)) as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> } | null;
  if (!agent) return challenge(msg?.id ?? null, Boolean(token));
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id ?? null, -32600, 'invalid JSON-RPC request', 400);
  }

  if (msg.method === 'initialize') {
    const asked = String(msg.params?.protocolVersion ?? '');
    return rpcResult(msg.id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'b1dz-agent', title: 'b1dz', version: '1.1.0' },
      instructions:
        'b1dz crypto trading for agents. get_budget, get_portfolio and get_quote are read-only. place_order queues a crypto BUY, hard-capped by this connection\'s budget; it fails when the connection has no trading budget.',
    });
  }
  if (msg.method.startsWith('notifications/')) return new Response(null, { status: 202, headers: CORS_HEADERS });
  if (msg.method === 'ping') return rpcResult(msg.id, {});

  if (msg.method === 'tools/list') {
    // resultType/ttlMs/cacheScope: required on list results by current MCP clients.
    return rpcResult(msg.id, { tools: TOOLS, resultType: 'complete', ttlMs: 300_000, cacheScope: 'public' });
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

/** No server-to-client stream: 401 for anyone signed out (starts OAuth), 405 otherwise. */
export async function GET(req: NextRequest) {
  const token = bearer(req);
  const agent = token ? await principal(req, token) : null;
  if (!agent) return challenge(null, Boolean(token));
  return new Response(null, { status: 405, headers: { ...CORS_HEADERS, allow: 'POST, OPTIONS' } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
