import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const authenticateMock = vi.fn();
const unauthorizedMock = vi.fn(() => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
const generateStrategyMock = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  authenticate: authenticateMock,
  unauthorized: unauthorizedMock,
}));

vi.mock('@/lib/strategy-ai', () => ({
  generateStrategy: generateStrategyMock,
}));

async function importRoute() {
  // fresh module each time so the in-memory rate limiter resets
  vi.resetModules();
  return (await import('./route.js')) as typeof import('./route.js');
}

function makeReq(body: unknown) {
  return new Request('http://test.local/api/strategies/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fake' },
    body: JSON.stringify(body),
  });
}

const goodBody = { niches: 'AI', goal: 'growth', knobs: { risk: 7, horizon: 4, frequency: 6, assetFocus: 8 } };

describe('POST /api/strategies/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateMock.mockResolvedValue({ userId: 'u1', client: {}, email: 'a@b.c' });
    generateStrategyMock.mockResolvedValue({ definition: { tsp: '0.1', id: 'x' }, description: 'desc' });
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('401 when unauthenticated', async () => {
    authenticateMock.mockResolvedValueOnce(null);
    const { POST } = await importRoute();
    expect((await POST(makeReq(goodBody) as never)).status).toBe(401);
  });

  it('503 when no operator key is configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { POST } = await importRoute();
    expect((await POST(makeReq(goodBody) as never)).status).toBe(503);
  });

  it('200 returns the generated strategy and passes clamped knobs through', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeReq(goodBody) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).description).toBe('desc');
    const [arg] = generateStrategyMock.mock.calls[0]!;
    expect(arg.knobs.risk).toBe(7);
    expect(arg.niches).toBe('AI');
  });

  it('502 when generation throws', async () => {
    generateStrategyMock.mockRejectedValueOnce(new Error('invalid strategy: bad'));
    const { POST } = await importRoute();
    const res = await POST(makeReq(goodBody) as never);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/invalid strategy/);
  });

  it('429 after exceeding the per-user rate limit', async () => {
    const { POST } = await importRoute();
    let last: Response | undefined;
    for (let i = 0; i < 10; i++) last = await POST(makeReq(goodBody) as never);
    expect(last!.status).toBe(429);
  });
});
