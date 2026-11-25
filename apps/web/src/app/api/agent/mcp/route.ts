import type { NextRequest } from 'next/server';
import { authenticateAgent, type AuthedAgent } from '@/lib/api-auth';
import { ACCESS_PREFIX, CORS_HEADERS, resolveAccessToken, resourceMetadataUrl, SCOPE } from '@/lib/mcp-oauth';
import { createAdminSupabase } from '@/lib/supabase';
import { getAgentBudget, getAgentPortfolio, getAgentQuote, placeAgentOrder } from '@/lib/agent-trade';
import { cardAsText, researchCatalog, researchSearch, runResearchCard } from '@/lib/research-api';
import { changeWatchlist, readWatchlist } from '@/lib/terminal-api';
import { cancelAgentStockOrder, getAgentBrokerAccount, placeAgentStockOrder, type AgentEquityResult } from '@/lib/agent-equity';

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
/** Research tools read public market data from outside b1dz. */
const READ_WORLD = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

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
  {
    name: 'research_catalog',
    title: 'List research cards',
    description:
      'List the market research cards (equities, options, rates, credit, FX, futures, energy, shipping, macro, SEC filings, news) with their ids, sources and params. Pass query to narrow by id or title, e.g. "yield curve", "options", "company".',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional filter on card id, title or description' } },
      additionalProperties: false,
    },
    annotations: { title: 'List research cards', ...READ },
  },
  {
    name: 'research_search',
    title: 'Search research',
    description:
      'Find a security or dataset: ticker, company name, SEC CIK, or a dataset word (cpi, sofr, payrolls). Each hit names the dashboard to use and the params (e.g. symbol) to pass to that dashboard\'s cards.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Ticker, company name, CIK, dataset or dashboard name' } },
      required: ['query'],
    },
    annotations: { title: 'Search research', ...READ_WORLD },
  },
  {
    name: 'research_card',
    title: 'Run a research card',
    description:
      'Run one research card and get its data with the source and data date. Ids come from research_catalog. params are the card\'s inputs, e.g. {"symbol":"NVDA","range":"1Y"} or {"country":"DE"}; omitted params take the card default. format "text" (default) returns aligned tables; "json" returns the raw blocks. Quotes can be delayed; research only, not investment advice.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Card id, e.g. rates.us-curve' },
        params: { type: 'object', description: 'Card inputs by name', additionalProperties: { type: 'string' } },
        format: { type: 'string', enum: ['text', 'json'], description: 'text (default) or json' },
      },
      required: ['id'],
    },
    annotations: { title: 'Run a research card', ...READ_WORLD },
  },
  {
    name: 'watchlist_get',
    title: 'Read the watchlist',
    description:
      'The tickers on this user\'s research terminal watchlist (the list b1dz.com/terminal shows). To price them, pass the symbols to research_card with id "overview.watchlist" and params {"symbols":"AAPL,MSFT"}.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Read the watchlist', ...READ },
  },
  {
    name: 'watchlist_edit',
    title: 'Edit the watchlist',
    description:
      'Add or remove tickers on this user\'s research terminal watchlist. A watchlist is only a list to look at: nothing here buys or sells, and the automated strategies never trade it. Returns the new list.',
    inputSchema: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string' }, description: 'Tickers to add, e.g. ["NVDA","BTC-USD"]' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tickers to remove' },
      },
      additionalProperties: false,
    },
    // Changes a saved list the user can change back; touches nothing outside b1dz.
    annotations: { title: 'Edit the watchlist', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'broker_account',
    title: 'Read the broker account',
    description:
      'The user\'s linked stock broker (Alpaca, moomoo, ...): which brokers are linked, paper or live, buying power, positions, and open and recent orders. Read-only. Fails with "locked" until the user unlocks trading with their passphrase.',
    inputSchema: {
      type: 'object',
      properties: { broker: { type: 'string', description: 'Linked broker id, e.g. alpaca or moomoo. Default: the user\'s chosen broker' } },
      additionalProperties: false,
    },
    annotations: { title: 'Read the broker account', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'place_stock_order',
    title: 'Place a stock order',
    description:
      'Buy or sell a U.S. stock or ETF through the user\'s own broker. Needs the trade:equity scope and, for a buy, budget: the cost is charged to this connection\'s budget. A buy must have a known maximum cost: notionalUsd (a market order for that many dollars), or a limit order with qty and limitPrice. A market buy by share count is refused. A sell can never exceed the shares held. Check broker_account first: "paper": false means real money. Confirm the symbol, side and size with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker, e.g. AAPL' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        qty: { type: 'number', description: 'Shares. Use this or notionalUsd, not both' },
        notionalUsd: { type: 'number', description: 'Dollar amount for a market order (brokers with fractional shares; others round down to whole shares)' },
        type: { type: 'string', enum: ['market', 'limit'], description: 'Default market' },
        limitPrice: { type: 'number', description: 'Required for a limit order' },
        tif: { type: 'string', enum: ['day', 'gtc'], description: 'Default day' },
        extendedHours: { type: 'boolean', description: 'Limit orders only' },
        broker: { type: 'string', description: 'Linked broker id. Default: the user\'s chosen broker' },
      },
      required: ['symbol', 'side'],
    },
    // Spends real money at a broker when the account is live: not read-only, not undoable.
    annotations: { title: 'Place a stock order', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'cancel_stock_order',
    title: 'Cancel a stock order',
    description: 'Cancel an open order at the user\'s broker by its orderId (from broker_account). Needs the trade:equity scope.',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string' }, broker: { type: 'string', description: 'Linked broker id. Default: the user\'s chosen broker' } },
      required: ['orderId'],
    },
    annotations: { title: 'Cancel a stock order', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
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
  // A string is already the answer (a rendered research card); everything else is JSON.
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }], isError };
}

/** A refused broker call is a tool error with the refusal as its text. */
function equity(r: AgentEquityResult): Record<string, unknown> {
  if (r.status >= 400) throw new Error(String(r.body.error ?? `request failed (${r.status})`));
  return r.body;
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
    case 'research_catalog': {
      const { dashboards, cards } = researchCatalog(typeof args.query === 'string' ? args.query : undefined);
      return {
        dashboards: dashboards.map((d) => ({ id: d.id, title: d.title, group: d.group, tabs: d.tabs.map((t) => ({ title: t.title, cards: t.cards })) })),
        cards: cards.map((c) => ({ id: c.id, title: c.title, source: c.source, needsKey: c.needsKey, params: c.params.map((p) => `${p.name}${p.default ? `=${p.default}` : ''}`) })),
      };
    }
    case 'research_search':
      return { hits: await researchSearch(String(args.query ?? '')) };
    case 'research_card': {
      const params = args.params && typeof args.params === 'object' ? (args.params as Record<string, unknown>) : {};
      const { body } = await runResearchCard(String(args.id ?? ''), params);
      if ('error' in body) throw new Error(body.error);
      return args.format === 'json' ? body : cardAsText(body);
    }
    case 'broker_account':
      return equity(await getAgentBrokerAccount(agent, args.broker));
    case 'place_stock_order':
      return equity(await placeAgentStockOrder(agent, args));
    case 'cancel_stock_order':
      return equity(await cancelAgentStockOrder(agent, args));
    case 'watchlist_get':
      return readWatchlist(agent.admin, agent.userId);
    case 'watchlist_edit':
      return changeWatchlist(agent.admin, agent.userId, args.add, args.remove);
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
      serverInfo: { name: 'b1dz-agent', title: 'b1dz', version: '1.4.0' },
      instructions:
        'b1dz crypto trading and market research for agents. get_budget, get_portfolio and get_quote are read-only. place_order queues a crypto BUY, hard-capped by this connection\'s budget; it fails when the connection has no trading budget. Research (read-only, public sources): research_catalog lists the cards, research_search finds a ticker or dataset, research_card runs one card (quotes, financials, option chains, yield curves, macro, filings, news) and names its source. watchlist_get and watchlist_edit read and change the user\'s research watchlist; a watchlist never trades. Stocks through the user\'s own broker: broker_account reads it; place_stock_order and cancel_stock_order need the trade:equity scope, charge buys to this connection\'s budget, and can be real money when the account is live, so confirm with the user first.',
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
