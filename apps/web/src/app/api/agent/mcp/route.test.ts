import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticateAgentMock = vi.fn();
const placeAgentOrderMock = vi.fn();
const getAgentBudgetMock = vi.fn();
const getAgentPortfolioMock = vi.fn();
const getAgentQuoteMock = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  authenticateAgent: (...a: unknown[]) => authenticateAgentMock(...a),
  // route imports the type only; provide a stub to satisfy the module
  unauthorized: () => new Response(null, { status: 401 }),
}));
vi.mock('@/lib/agent-trade', () => ({
  placeAgentOrder: (...a: unknown[]) => placeAgentOrderMock(...a),
  getAgentBudget: (...a: unknown[]) => getAgentBudgetMock(...a),
  getAgentPortfolio: (...a: unknown[]) => getAgentPortfolioMock(...a),
  getAgentQuote: (...a: unknown[]) => getAgentQuoteMock(...a),
}));

async function importRoute() {
  return (await import('./route.js')) as typeof import('./route.js');
}

function rpc(method: string, params?: unknown, id: unknown = 1, withAuth = true) {
  return new Request('http://test.local/api/agent/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withAuth ? { authorization: 'Bearer b1dz_agent_test' } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

describe('MCP route (e2e)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAgentMock.mockResolvedValue({ token: { scopes: ['read', 'trade:crypto'] }, scopes: ['read', 'trade:crypto'], tokenId: 't', userId: 'u', admin: {} });
  });

  it('handles initialize without auth and advertises tool capability', async () => {
    const { POST } = await importRoute();
    const res = await POST(rpc('initialize', {}, 1, false) as never);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('b1dz-agent');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('rejects a bad JSON-RPC envelope with 400', async () => {
    const { POST } = await importRoute();
    const bad = new Request('http://test.local/api/agent/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ foo: 'bar' }),
    });
    const res = await POST(bad as never);
    expect(res.status).toBe(400);
  });

  it('lists the four tools (requires auth)', async () => {
    const { POST } = await importRoute();
    const res = await POST(rpc('tools/list') as never);
    const body = await res.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(['get_budget', 'get_portfolio', 'get_quote', 'place_order']);
  });

  it('401s tool calls without a valid agent token', async () => {
    authenticateAgentMock.mockResolvedValueOnce(null);
    const { POST } = await importRoute();
    const res = await POST(rpc('tools/list', undefined, 1) as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  it('routes tools/call place_order through placeAgentOrder', async () => {
    placeAgentOrderMock.mockResolvedValue({ status: 202, body: { status: 'accepted', idempotencyKey: 'k' } });
    const { POST } = await importRoute();
    const res = await POST(rpc('tools/call', { name: 'place_order', arguments: { pair: 'BTC-USD', usd: 25 } }) as never);
    const body = await res.json();
    expect(placeAgentOrderMock).toHaveBeenCalledOnce();
    expect(placeAgentOrderMock.mock.calls[0]![1]).toMatchObject({ pair: 'BTC-USD', usd: 25 });
    // tool result is wrapped as MCP text content
    const text = JSON.parse(body.result.content[0].text);
    expect(text.status).toBe('accepted');
    expect(body.result.isError).toBe(false);
  });

  it('returns an isError tool result for an unknown tool', async () => {
    const { POST } = await importRoute();
    const res = await POST(rpc('tools/call', { name: 'launch_missiles', arguments: {} }) as never);
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).error).toMatch(/unknown tool/);
  });

  it('returns -32601 for an unknown method', async () => {
    const { POST } = await importRoute();
    const res = await POST(rpc('resources/list') as never);
    const body = await res.json();
    expect(body.error.code).toBe(-32601);
  });
});
