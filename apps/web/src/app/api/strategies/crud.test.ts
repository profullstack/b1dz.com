import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the saved-strategy CRUD endpoints with a tiny
 * chainable Supabase stub: each terminal call resolves the next queued result.
 */
const authenticateMock = vi.fn();
const results: { data: unknown; error: unknown }[] = [];
const calls: { table: string; ops: [string, unknown[]][] }[] = [];

function client() {
  return {
    from(table: string) {
      const entry = { table, ops: [] as [string, unknown[]][] };
      calls.push(entry);
      const q: Record<string, unknown> = {};
      for (const op of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'limit']) {
        q[op] = (...args: unknown[]) => {
          entry.ops.push([op, args]);
          return q;
        };
      }
      const settle = () => Promise.resolve(results.shift() ?? { data: null, error: null });
      q.single = settle;
      q.maybeSingle = settle;
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
      return q;
    },
  };
}

vi.mock('@/lib/api-auth', () => ({
  authenticate: authenticateMock,
  unauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/supabase', () => ({ createAdminSupabase: () => client() }));

const ID = '0b0e6a8e-6c1f-4b8e-9a52-2f3d0c9d1e11';
const doc = {
  tsp: '0.1',
  id: 'ai-rsi',
  name: 'AI RSI Dip',
  assetClasses: ['crypto'],
  definition: { kind: 'template', template: 'mean-reversion', params: { oversold: 35 } },
};
const req = (url: string, method = 'GET', body?: unknown) =>
  Object.assign(
    new Request(`http://t.local${url}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } }),
    { nextUrl: new URL(`http://t.local${url}`) },
  ) as never;
const params = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  results.length = 0;
  calls.length = 0;
  authenticateMock.mockReset();
  authenticateMock.mockResolvedValue({ userId: 'u1', client: client(), email: null });
});

describe('/api/strategies', () => {
  it('POST saves a validated strategy owned by the caller', async () => {
    const { POST } = await import('./route.js');
    results.push({ data: { id: ID, slug: 'ai-rsi' }, error: null });
    const res = await POST(req('/api/strategies', 'POST', { definition: doc }));
    expect(res.status).toBe(201);
    const insert = calls[0]!.ops.find(([op]) => op === 'insert')![1][0] as Record<string, unknown>;
    expect(insert).toMatchObject({ user_id: 'u1', slug: 'ai-rsi', name: 'AI RSI Dip', forked_from: null });
  });

  it('POST 400s on an invalid document without touching the DB', async () => {
    const { POST } = await import('./route.js');
    const res = await POST(req('/api/strategies', 'POST', { definition: { tsp: '0.1' } }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('POST 409s on a duplicate slug', async () => {
    const { POST } = await import('./route.js');
    results.push({ data: null, error: { code: '23505', message: 'dup' } });
    const res = await POST(req('/api/strategies', 'POST', { definition: doc }));
    expect(res.status).toBe(409);
  });

  it('GET lists only the caller’s rows', async () => {
    const { GET } = await import('./route.js');
    results.push({ data: [{ id: ID }], error: null });
    const res = await GET(req('/api/strategies'));
    expect((await res.json()).strategies).toHaveLength(1);
    expect(calls[0]!.ops).toContainEqual(['eq', ['user_id', 'u1']]);
  });

  it('GET ?scope=published needs no auth and filters to published', async () => {
    authenticateMock.mockResolvedValue(null);
    const { GET } = await import('./route.js');
    results.push({ data: [], error: null });
    const res = await GET(req('/api/strategies?scope=published'));
    expect(res.status).toBe(200);
    expect(calls[0]!.ops).toContainEqual(['eq', ['visibility', 'published']]);
  });
});

describe('/api/strategies/:id', () => {
  it('GET hides a private strategy from other users', async () => {
    authenticateMock.mockResolvedValue({ userId: 'someone-else', client: client(), email: null });
    const { GET } = await import('./[id]/route.js');
    results.push({ data: { id: ID, user_id: 'u1', visibility: 'private' }, error: null });
    expect((await GET(req(`/api/strategies/${ID}`), params)).status).toBe(404);
  });

  it('GET shows a published strategy without its owner id', async () => {
    authenticateMock.mockResolvedValue(null);
    const { GET } = await import('./[id]/route.js');
    results.push({ data: { id: ID, user_id: 'u1', visibility: 'published' }, error: null });
    const body = await (await GET(req(`/api/strategies/${ID}`), params)).json();
    expect(body.owned).toBe(false);
    expect(body.strategy.user_id).toBeUndefined();
  });

  it('PATCH 404s when the row is not the caller’s', async () => {
    const { PATCH } = await import('./[id]/route.js');
    results.push({ data: null, error: null });
    expect((await PATCH(req(`/api/strategies/${ID}`, 'PATCH', { definition: doc }), params)).status).toBe(404);
  });

  it('DELETE removes the caller’s row', async () => {
    const { DELETE } = await import('./[id]/route.js');
    results.push({ data: [{ id: ID }], error: null });
    const res = await DELETE(req(`/api/strategies/${ID}`, 'DELETE'), params);
    expect(res.status).toBe(200);
    expect(calls[0]!.ops).toContainEqual(['eq', ['user_id', 'u1']]);
  });

  it('rejects a non-uuid id as 404', async () => {
    const { DELETE } = await import('./[id]/route.js');
    const res = await DELETE(req('/api/strategies/x', 'DELETE'), { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(404);
  });

  it('requires auth to mutate', async () => {
    authenticateMock.mockResolvedValue(null);
    const { DELETE } = await import('./[id]/route.js');
    expect((await DELETE(req(`/api/strategies/${ID}`, 'DELETE'), params)).status).toBe(401);
  });
});
