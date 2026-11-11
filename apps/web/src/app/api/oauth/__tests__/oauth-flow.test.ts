import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';

// In-memory tables behind a query builder with just the calls lib/mcp-oauth.ts
// makes. Ported from profullstack/threatcrush#450 and smshub#140.
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let cookieUser: string | null = null;
const bearerSessions: Record<string, string> = {};

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let payload: Row = {};
  const rows = () => (tables[table] ??= []);
  const run = (): Row[] => {
    if (op === 'insert') {
      const row: Row = { id: randomBytes(8).toString('hex'), created_at: new Date().toISOString(), revoked_at: null, used_at: null, last_used_at: null, ...payload };
      rows().push(row);
      return [row];
    }
    const matched = rows().filter((r) => filters.every((f) => f(r)));
    if (op === 'update') for (const r of matched) Object.assign(r, payload);
    if (op === 'delete') tables[table] = rows().filter((r) => !matched.includes(r));
    return matched;
  };
  const b = {
    insert(p: Row) { op = 'insert'; payload = p; return b; },
    update(p: Row) { op = 'update'; payload = p; return b; },
    delete() { op = 'delete'; return b; },
    select() { return b; },
    order() { return b; },
    eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return b; },
    is(col: string, val: unknown) { filters.push((r) => (r[col] ?? null) === val); return b; },
    gt(col: string, val: string) { filters.push((r) => String(r[col]) > val); return b; },
    gte(col: string, val: string) { filters.push((r) => String(r[col]) >= val); return b; },
    async maybeSingle() { const [r] = run(); return { data: r ?? null, error: null }; },
    async single() { const [r] = run(); return r ? { data: r, error: null } : { data: null, error: { message: 'no rows' } }; },
    then(resolve: (v: { data: Row[]; error: null }) => void) { resolve({ data: run(), error: null }); },
  };
  return b;
}

const admin = { from: (t: string) => builder(t) };
const AGENT_KEY = 'b1dz_agent_existingkey';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

vi.mock('@/lib/supabase', () => ({
  createAdminSupabase: () => admin,
  createServerSupabase: async () => ({
    auth: { getUser: async () => ({ data: { user: cookieUser ? { id: cookieUser, email: `${cookieUser}@example.com` } : null } }) },
  }),
}));
// Session auth (cookie or Supabase Bearer JWT) and agent-key auth, against the fake tables.
vi.mock('@/lib/api-auth', () => ({
  authenticate: async (req: Request) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
    if (m) return bearerSessions[m[1]] ? { client: admin, userId: bearerSessions[m[1]], email: null } : null;
    return cookieUser ? { client: admin, userId: cookieUser, email: null } : null;
  },
  authenticateAgent: async (req: Request) => {
    const raw = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!raw.startsWith('b1dz_agent_')) return null;
    const row = (tables.agent_tokens ?? []).find((r) => r.token_hash === sha(raw) && !r.revoked_at);
    return row ? { admin, userId: row.user_id, tokenId: row.id, scopes: row.scopes, token: row } : null;
  },
  unauthorized: () => new Response(null, { status: 401 }),
}));
const getAgentBudget = vi.fn(async (agent: { tokenId: string; scopes: string[]; token: Row }) => ({
  status: 200,
  body: { tokenId: agent.tokenId, scopes: agent.scopes, budgetUsd: Number(agent.token.budget_usd) },
}));
vi.mock('@/lib/agent-trade', () => ({
  getAgentBudget: (a: never) => getAgentBudget(a),
  getAgentPortfolio: async () => ({ status: 200, body: {} }),
  getAgentQuote: async () => ({ status: 200, body: {} }),
  placeAgentOrder: async () => ({ status: 202, body: {} }),
}));

process.env.SITE_URL = 'https://b1dz.com';
const ORIGIN = 'https://b1dz.com';
const MCP_URL = `${ORIGIN}/api/agent/mcp`;

const { POST: register } = await import('../register/route');
const { POST: token } = await import('../token/route');
const { POST: decide } = await import('../authorize/route');
const { POST: revoke } = await import('../revoke/route');
const { POST: mcp, GET: mcpGet } = await import('../../agent/mcp/route');
const { GET: resourceMeta } = await import('../../../.well-known/oauth-protected-resource/route');
const { GET: asMeta } = await import('../../../.well-known/oauth-authorization-server/route');
const oauth = await import('@/lib/mcp-oauth');

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const tokenReq = (body: Record<string, string>) =>
  new NextRequest(`${ORIGIN}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function newClient(redirect_uris = [CLAUDE, CHATGPT, 'http://localhost:33418/callback', 'http://127.0.0.1:33418/callback']) {
  const res = await register(json(`${ORIGIN}/api/oauth/register`, { client_name: 'Claude', redirect_uris }));
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; token_endpoint_auth_method: string };
}

/** The consent page's JSON decision as the signed-in user (cookie session, same origin). */
async function authorize(clientId: string, challenge: string, redirect = CLAUDE, extra: Record<string, unknown> = {}) {
  cookieUser = 'user-1';
  const res = await decide(
    json(
      `${ORIGIN}/api/oauth/authorize`,
      {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
        resource: MCP_URL,
        approve: true,
        ...extra,
      },
      { origin: ORIGIN },
    ),
  );
  expect(res.status).toBe(200);
  const u = new URL(((await res.json()) as { redirect: string }).redirect);
  expect(u.searchParams.get('state')).toBe('xyz');
  expect(u.searchParams.get('iss')).toBe(ORIGIN);
  return u.searchParams.get('code')!;
}

async function connect(extra: Record<string, unknown> = {}) {
  const { client_id } = await newClient();
  const { verifier, challenge } = pkce();
  const code = await authorize(client_id, challenge, CLAUDE, extra);
  const res = await token(tokenReq({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: CLAUDE }));
  expect(res.status).toBe(200);
  return { client_id, ...((await res.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string }) };
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(bearerSessions)) delete bearerSessions[k];
  cookieUser = null;
  // An existing agent key, made on /settings before OAuth existed.
  tables.agent_tokens = [{ id: 'legacy', user_id: 'user-1', token_hash: sha(AGENT_KEY), scopes: ['read', 'trade:crypto'], budget_usd: 25, budget_window: 'daily', revoked_at: null }];
});

describe('discovery', () => {
  it('serves protected-resource metadata whose resource is exactly the MCP URL', async () => {
    const r = await resourceMeta().json();
    expect(r.resource).toBe(MCP_URL);
    expect(r.authorization_servers[0]).toBe(ORIGIN);
  });
  it('serves authorization-server metadata with DCR, S256 and refresh', async () => {
    const a = await asMeta().json();
    expect(a).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe('MCP route auth', () => {
  it('answers any request without a credential with 401 + resource_metadata, initialize included', async () => {
    for (const res of [await mcp(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })), await mcpGet(new NextRequest(MCP_URL))]) {
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
    }
  });
  it('answers a bad credential with 401 invalid_token', async () => {
    const res = await mcp(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer b1dz_oat_nope' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
  it('still accepts an existing b1dz_agent_ key exactly as before', async () => {
    const res = await mcp(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_budget', arguments: {} } }, { authorization: `Bearer ${AGENT_KEY}` }));
    expect(res.status).toBe(200);
    const out = JSON.parse(((await res.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text);
    expect(out).toMatchObject({ tokenId: 'legacy', scopes: ['read', 'trade:crypto'], budgetUsd: 25 });
  });
});

describe('dynamic client registration', () => {
  it('registers a public client with the claude.ai, chatgpt and loopback redirects', async () => {
    const c = await newClient();
    expect(c.client_id).toMatch(/^b1dz_client_[0-9a-f]{32}$/);
    expect(c.token_endpoint_auth_method).toBe('none');
  });
  it('refuses confidential clients and non-https redirects', async () => {
    const conf = await register(json(`${ORIGIN}/api/oauth/register`, { redirect_uris: [CLAUDE], token_endpoint_auth_method: 'client_secret_basic' }));
    expect(conf.status).toBe(400);
    const http = await register(json(`${ORIGIN}/api/oauth/register`, { redirect_uris: ['http://evil.example/cb'] }));
    expect(((await http.json()) as { error: string }).error).toBe('invalid_redirect_uri');
  });
});

describe('authorization', () => {
  it('needs a signed-in user, and refuses a cross-site cookie POST', async () => {
    const { client_id } = await newClient();
    const { challenge } = pkce();
    const body = { response_type: 'code', client_id, redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: 'S256', approve: true };
    expect((await decide(json(`${ORIGIN}/api/oauth/authorize`, body, { origin: ORIGIN }))).status).toBe(401);
    cookieUser = 'user-1';
    expect((await decide(json(`${ORIGIN}/api/oauth/authorize`, body, { origin: 'https://evil.example' }))).status).toBe(401);
  });
  it('accepts a Bearer session (headless) and requires PKCE S256', async () => {
    bearerSessions['jwt-1'] = 'user-1';
    const { client_id } = await newClient();
    const res = await decide(
      json(`${ORIGIN}/api/oauth/authorize`, { response_type: 'code', client_id, redirect_uri: CLAUDE, code_challenge_method: 'plain', approve: true }, { authorization: 'Bearer jwt-1' }),
    );
    const u = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(u.searchParams.get('error')).toBe('invalid_request');
    expect(u.searchParams.get('iss')).toBe(ORIGIN);
  });
  it('sends access_denied back on Deny', async () => {
    const { client_id } = await newClient();
    cookieUser = 'user-1';
    const res = await decide(
      json(`${ORIGIN}/api/oauth/authorize`, { response_type: 'code', client_id, redirect_uri: CHATGPT, code_challenge: pkce().challenge, code_challenge_method: 'S256', approve: false }, { origin: ORIGIN }),
    );
    expect(new URL(((await res.json()) as { redirect: string }).redirect).searchParams.get('error')).toBe('access_denied');
  });
  it('allows a loopback redirect on another port (RFC 8252)', async () => {
    const { client_id } = await newClient();
    const code = await authorize(client_id, pkce().challenge, 'http://127.0.0.1:51234/callback');
    expect(code).toBeTruthy();
  });
});

describe('PKCE flow', () => {
  it('code -> tokens -> tools/list -> refresh rotation -> revoke', async () => {
    const t = await connect();
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(t.access_token.startsWith('b1dz_oat_')).toBe(true);

    const list = await mcp(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${t.access_token}` }));
    expect(list.status).toBe(200);
    const result = ((await list.json()) as { result: { tools: Array<{ name: string; annotations: Record<string, unknown> }>; ttlMs: number; cacheScope: string } }).result;
    expect(result.tools.map((x) => x.name).sort()).toEqual(['get_budget', 'get_portfolio', 'get_quote', 'place_order']);
    expect(result.cacheScope).toBe('public');
    for (const tool of result.tools) expect(typeof tool.annotations.readOnlyHint).toBe('boolean');

    const r = await token(tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id }));
    expect(r.status).toBe(200);
    const t2 = (await r.json()) as { access_token: string; refresh_token: string };
    expect(t2.access_token).not.toBe(t.access_token);
    expect((await mcp(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${t.access_token}` }))).status).toBe(401);
    expect((await mcp(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${t2.access_token}` }))).status).toBe(200);
    // Replayed refresh token is refused.
    expect((await token(tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token }))).status).toBe(400);

    await revoke(new NextRequest(`${ORIGIN}/api/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${t2.access_token}` }));
    expect((await mcp(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { authorization: `Bearer ${t2.access_token}` }))).status).toBe(401);
    // The grant's agent sub-account is revoked with it; the legacy key is untouched.
    expect(tables.agent_tokens.find((x) => x.id !== 'legacy')?.revoked_at).toBeTruthy();
    expect(tables.agent_tokens.find((x) => x.id === 'legacy')?.revoked_at).toBeNull();
  });

  it('is read-only with no budget unless the user grants one, and never wider than an agent key', async () => {
    const ro = await connect();
    const out = async (access: string) =>
      JSON.parse(
        ((await (await mcp(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_budget' } }, { authorization: `Bearer ${access}` }))).json()) as {
          result: { content: Array<{ text: string }> };
        }).result.content[0].text,
      );
    expect(await out(ro.access_token)).toMatchObject({ scopes: ['read'], budgetUsd: 0 });
    const tr = await connect({ trade: true, budget_usd: 40, budget_window: 'weekly' });
    expect(await out(tr.access_token)).toMatchObject({ scopes: ['read', 'trade:crypto'], budgetUsd: 40 });
    // Every grant is its own sub-account bound to the approving user.
    const grants = tables.agent_tokens.filter((x) => x.id !== 'legacy');
    expect(grants).toHaveLength(2);
    for (const g of grants) expect(g.user_id).toBe('user-1');
  });

  it('refuses a wrong verifier, a reused code and a mismatched redirect_uri', async () => {
    const { client_id } = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(client_id, challenge);
    expect((await token(tokenReq({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, redirect_uri: CLAUDE }))).status).toBe(400);
    expect((await token(tokenReq({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE }))).status).toBe(400);
    const code2 = await authorize(client_id, challenge);
    expect((await token(tokenReq({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, redirect_uri: CHATGPT }))).status).toBe(400);
  });

  it('ends the grant when its agent token is revoked on /settings', async () => {
    const t = await connect();
    for (const g of tables.agent_tokens) if (g.id !== 'legacy') g.revoked_at = new Date().toISOString();
    expect((await mcp(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${t.access_token}` }))).status).toBe(401);
    expect((await token(tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token }))).status).toBe(400);
  });

  it('stores only hashes', async () => {
    const t = await connect();
    const dump = JSON.stringify(tables);
    expect(dump).not.toContain(t.access_token);
    expect(dump).not.toContain(t.refresh_token);
    expect(oauth.hashToken(t.access_token)).toHaveLength(64);
  });
});
