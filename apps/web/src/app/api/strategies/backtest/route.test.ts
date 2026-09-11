import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticateMock = vi.fn();
const unauthorizedMock = vi.fn(() => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
const validateMock = vi.fn();
const compileMock = vi.fn();
const runBacktestMock = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  authenticate: authenticateMock,
  unauthorized: unauthorizedMock,
}));

vi.mock('@b1dz/source-strategies', () => ({
  tsp: { validateDefinition: validateMock, compile: compileMock },
}));

vi.mock('@/lib/strategy-backtest-runner', () => ({
  runStrategyBacktest: runBacktestMock,
  DEFAULT_TIMEFRAME: '1 year',
  TIMEFRAMES: [
    { label: '1 month' }, { label: '3 months' }, { label: '6 months' },
    { label: '1 year' }, { label: '2 years' }, { label: '5 years' },
  ],
}));

async function importRoute() {
  return (await import('./route.js')) as typeof import('./route.js');
}

function makeReq(body: unknown) {
  return new Request('http://test.local/api/strategies/backtest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fake' },
    body: JSON.stringify(body),
  });
}

const validDoc = { tsp: '0.1', id: 'x', name: 'X', definition: { kind: 'template', template: 'breakout' } };

describe('POST /api/strategies/backtest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateMock.mockResolvedValue({ userId: 'u1', client: {}, email: 'a@b.c' });
    validateMock.mockReturnValue({ ok: true, errors: [] });
    compileMock.mockReturnValue({ manifest: { id: 'x', name: 'X' } });
    runBacktestMock.mockResolvedValue({ bankroll: 1000, timeframe: '1 year', startYmd: '2025-06-30', endYmd: '2026-06-30', classes: [], verdict: null });
  });

  it('401 when unauthenticated', async () => {
    authenticateMock.mockResolvedValueOnce(null);
    const { POST } = await importRoute();
    expect((await POST(makeReq(validDoc) as never)).status).toBe(401);
  });

  it('400 when the definition is invalid', async () => {
    validateMock.mockReturnValueOnce({ ok: false, errors: ['bad'] });
    const { POST } = await importRoute();
    const res = await POST(makeReq({ definition: { nope: true } }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual(['bad']);
    expect(runBacktestMock).not.toHaveBeenCalled();
  });

  it('400 when compilation throws', async () => {
    compileMock.mockImplementationOnce(() => {
      throw new Error('unknown operand "ghost"');
    });
    const { POST } = await importRoute();
    const res = await POST(makeReq({ definition: validDoc }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ghost/);
  });

  it('defaults to both classes, $1000 bankroll, and the 1-year time frame', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeReq({ definition: validDoc }) as never);
    expect(res.status).toBe(200);
    const [, opts] = runBacktestMock.mock.calls[0]!;
    expect(opts.classes).toEqual(['crypto', 'equity']);
    expect(opts.bankroll).toBe(1000);
    expect(opts.timeframe).toBe('1 year');
    expect(typeof opts.fetchCloses).toBe('function');
    const body = await res.json();
    expect(body.strategy).toEqual({ id: 'x', name: 'X' });
  });

  it('passes through a single class, custom bankroll, and time frame', async () => {
    const { POST } = await importRoute();
    await POST(makeReq({ definition: validDoc, classes: ['crypto'], bankroll: 5000, timeframe: '5 years' }) as never);
    const [, opts] = runBacktestMock.mock.calls[0]!;
    expect(opts.classes).toEqual(['crypto']);
    expect(opts.bankroll).toBe(5000);
    expect(opts.timeframe).toBe('5 years');
  });

  it('falls back to the default time frame for an invalid label', async () => {
    const { POST } = await importRoute();
    await POST(makeReq({ definition: validDoc, timeframe: 'forever' }) as never);
    const [, opts] = runBacktestMock.mock.calls[0]!;
    expect(opts.timeframe).toBe('1 year');
  });

  it('ignores unknown class names, erroring only when none remain', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeReq({ definition: validDoc, classes: ['forex'] }) as never);
    expect(res.status).toBe(400);
    expect(runBacktestMock).not.toHaveBeenCalled();
  });
});

describe('equity closes via nichedb (NICHEDB_MARKETS)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());

  /** A fresh 400-bar history item ending yesterday, weekdays only. */
  function historyItem(symbol: string) {
    const bars: (string | number | null)[][] = [];
    let ms = today - DAY;
    while (bars.length < 400) {
      const dow = new Date(ms).getUTCDay();
      if (dow !== 0 && dow !== 6) bars.unshift([new Date(ms).toISOString().slice(0, 10), 10, 11, 9, 10 + bars.length, 1000, null]);
      ms -= DAY;
    }
    return {
      id: 7, collection: 'markets', kind: 'history', external_id: `history:${symbol}`, title: `${symbol} daily bars`,
      published_at: null, updated_at: new Date().toISOString(), tags: ['history', `symbol:${symbol.toLowerCase()}`, 'feed:iex'],
      data: { symbol, timeframe: '1Day', feed: 'iex', adjustment: 'split', bars, first: bars[0]![0], last: bars[399]![0], count: 400 },
    };
  }

  function installFetch(nichedbItems: unknown[]) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.href;
      urls.push(url);
      const host = new URL(url).host;
      if (host === 'nichedb.dev') return Response.json({ count: nichedbItems.length, items: nichedbItems });
      if (host === 'query1.finance.yahoo.com') {
        return Response.json({ chart: { result: [{ timestamp: [1_700_000_000, 1_700_086_400], indicators: { quote: [{ close: [1, 2] }] } }] } });
      }
      return new Response('nope', { status: 404 });
    }));
    return urls;
  }

  async function equityCloses(symbol: string, days: number) {
    const { POST } = await importRoute();
    await POST(makeReq({ definition: validDoc, classes: ['equity'] }) as never);
    const [, opts] = runBacktestMock.mock.calls[0]!;
    return opts.fetchCloses(symbol, today - days * DAY, today) as Promise<{ ts: number; close: number }[]>;
  }

  beforeEach(() => {
    vi.stubEnv('ALPACA_API_KEY_ID', '');
    vi.stubEnv('ALPACA_API_SECRET_KEY', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('makes no nichedb request when the switch is off', async () => {
    vi.stubEnv('NICHEDB_MARKETS', '');
    const urls = installFetch([historyItem('AAPL')]);
    const rows = await equityCloses('AAPL', 365);
    expect(urls.some((u) => u.includes('nichedb.dev'))).toBe(false);
    expect(urls.some((u) => u.includes('finance.yahoo.com'))).toBe(true);
    expect(rows.map((r) => r.close)).toEqual([1, 2]);
  });

  it('serves a one-year window from nichedb bars without touching Yahoo', async () => {
    vi.stubEnv('NICHEDB_MARKETS', '1');
    const urls = installFetch([historyItem('AAPL')]);
    const rows = await equityCloses('AAPL', 365);
    expect(urls).toHaveLength(1);
    const q = new URL(urls[0]!).searchParams;
    expect(q.get('collection')).toBe('markets');
    expect(q.get('kind')).toBe('history');
    expect(q.get('tags')).toBe('symbol:aapl');
    expect(q.get('limit')).toBe('1');
    expect(rows.length).toBeGreaterThan(240);
    expect(rows[rows.length - 1]!.ts).toBe(rows[rows.length - 1]!.ts - (rows[rows.length - 1]!.ts % DAY)); // midnight UTC
    expect(rows.every((r) => Number.isFinite(r.close))).toBe(true);
  });

  it('falls back to Yahoo when nichedb has no history for the symbol', async () => {
    vi.stubEnv('NICHEDB_MARKETS', '1');
    const urls = installFetch([]);
    const rows = await equityCloses('ZZZZ', 90);
    expect(urls.some((u) => u.includes('nichedb.dev'))).toBe(true);
    expect(urls.some((u) => u.includes('finance.yahoo.com'))).toBe(true);
    expect(rows.map((r) => r.close)).toEqual([1, 2]);
  });

  it('skips nichedb for a window longer than its 400 bars and uses Yahoo', async () => {
    vi.stubEnv('NICHEDB_MARKETS', '1');
    const urls = installFetch([historyItem('AAPL')]);
    const rows = await equityCloses('AAPL', 5 * 365);
    expect(urls.some((u) => u.includes('nichedb.dev'))).toBe(false);
    expect(rows.map((r) => r.close)).toEqual([1, 2]);
  });
});
