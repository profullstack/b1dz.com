import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticateMock = vi.fn();
const authenticateAgentMock = vi.fn();
const runMock = vi.fn();
const searchMock = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  authenticate: (...a: unknown[]) => authenticateMock(...a),
  authenticateAgent: (...a: unknown[]) => authenticateAgentMock(...a),
}));

// The registry is real except for the two calls that would reach the network.
vi.mock('@b1dz/research', async (original) => {
  const real = (await original()) as typeof import('@b1dz/research');
  const reg = real.registry();
  return {
    ...real,
    registry: () =>
      new Proxy(reg, {
        get(target, prop) {
          if (prop === 'run') return (...a: unknown[]) => runMock(...a);
          if (prop === 'search') return (...a: unknown[]) => searchMock(...a);
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
  };
});

const CARD = 'overview.watchlist';
const RUN = {
  id: CARD,
  title: 'Watchlist',
  source: 'Nasdaq',
  asOf: '2026-11-24',
  params: { symbols: 'AAPL' },
  blocks: [{ kind: 'table', columns: [{ key: 'name', label: 'Name' }, { key: 'last', label: 'Last', format: 'num' }], rows: [{ name: 'AAPL', last: 349.08 }] }],
};

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://test.local${path}`, { headers }) as never;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('research API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateMock.mockResolvedValue({ userId: 'u1' });
    authenticateAgentMock.mockResolvedValue({ userId: 'u2' });
    runMock.mockResolvedValue(RUN);
    searchMock.mockResolvedValue([{ kind: 'security', label: 'AAPL Apple Inc.', dashboard: 'company', params: { symbol: 'AAPL' } }]);
  });

  it('serves the catalog without a credential', async () => {
    const { GET } = await import('./route.js');
    const res = GET(get('/api/research'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cards.some((c: { id: string }) => c.id === CARD)).toBe(true);
    expect(body.dashboards.some((d: { id: string }) => d.id === 'summary')).toBe(true);
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('narrows the catalog with q', async () => {
    const { GET } = await import('./route.js');
    const body = await GET(get('/api/research?q=watchlist')).json();
    expect(body.cards.map((c: { id: string }) => c.id)).toEqual([CARD]);
    expect(body.dashboards.map((d: { id: string }) => d.id)).toEqual(['summary']);
  });

  it('refuses a card to an unknown caller', async () => {
    authenticateMock.mockResolvedValue(null);
    const { GET } = await import('./card/[id]/route.js');
    const res = await GET(get(`/api/research/card/${CARD}`), params(CARD));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('runs a card for a signed-in user and passes the query as params', async () => {
    const { GET } = await import('./card/[id]/route.js');
    const res = await GET(get(`/api/research/card/${CARD}?symbols=AAPL&format=json`), params(CARD));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: CARD, source: 'Nasdaq' });
    expect(runMock.mock.calls[0][1]).toBe(CARD);
    expect(runMock.mock.calls[0][2]).toEqual({ symbols: 'AAPL' });
  });

  it('accepts an agent token', async () => {
    authenticateMock.mockResolvedValue(null);
    const { GET } = await import('./card/[id]/route.js');
    const res = await GET(get(`/api/research/card/${CARD}`, { authorization: 'Bearer b1dz_agent_x' }), params(CARD));
    expect(res.status).toBe(200);
    expect(authenticateAgentMock).toHaveBeenCalled();
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('returns text and CSV on request', async () => {
    const { GET } = await import('./card/[id]/route.js');
    const text = await (await GET(get(`/api/research/card/${CARD}?format=text`), params(CARD))).text();
    expect(text).toContain('Watchlist  symbols=AAPL\nSource: Nasdaq, as of 2026-11-24');
    expect(text).toContain('AAPL  349.08');
    const csv = await GET(get(`/api/research/card/${CARD}?format=csv`), params(CARD));
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('Name,Last\nAAPL,349.08\n');
  });

  it('answers 404 for an unknown card, 424 for a missing key and 502 when the source fails', async () => {
    const { GET } = await import('./card/[id]/route.js');
    expect((await GET(get('/api/research/card/nope.nope'), params('nope.nope'))).status).toBe(404);

    const { MissingKeyError } = await import('@b1dz/research');
    runMock.mockRejectedValueOnce(new MissingKeyError('EIA'));
    const needsKey = await GET(get(`/api/research/card/${CARD}`), params(CARD));
    expect(needsKey.status).toBe(424);
    expect(await needsKey.json()).toMatchObject({ needsKey: 'EIA' });

    runMock.mockRejectedValueOnce(new Error('Nasdaq: HTTP 503'));
    const down = await GET(get(`/api/research/card/${CARD}`), params(CARD));
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: 'Nasdaq: HTTP 503' });
  });

  it('searches for a signed-in caller and requires q', async () => {
    const { GET } = await import('./search/route.js');
    expect((await GET(get('/api/research/search'))).status).toBe(400);
    const res = await GET(get('/api/research/search?q=apple'));
    expect((await res.json()).hits[0]).toMatchObject({ dashboard: 'company', params: { symbol: 'AAPL' } });
    authenticateMock.mockResolvedValue(null);
    expect((await GET(get('/api/research/search?q=apple'))).status).toBe(401);
  });
});
