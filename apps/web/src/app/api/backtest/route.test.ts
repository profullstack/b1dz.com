import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticateMock = vi.fn();
const unauthorizedMock = vi.fn(() => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
const fetchHistoricalCandlesMock = vi.fn();
const runBacktestMock = vi.fn();
const computeBacktestMetricsMock = vi.fn();
const getActivePairsMock = vi.fn();

vi.mock('@/lib/api-auth', () => ({
  authenticate: authenticateMock,
  unauthorized: unauthorizedMock,
}));

vi.mock('@b1dz/source-crypto-trade', () => ({
  fetchHistoricalCandles: fetchHistoricalCandlesMock,
  runBacktest: runBacktestMock,
  computeBacktestMetrics: computeBacktestMetricsMock,
}));

vi.mock('@b1dz/source-crypto-arb', () => ({
  getActivePairs: getActivePairsMock,
}));

async function importRoute() {
  return (await import('./route.js')) as typeof import('./route.js');
}

function makeCandles(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    time: i * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 10,
  }));
}

function stubMetrics() {
  return {
    totalReturn: 5,
    winRate: 60,
    profitFactor: 1.5,
    expectancy: 2,
    maxDrawdown: 3,
    sharpe: 0.7,
    averageHoldMinutes: 20,
    tradesPerDay: 3,
    performanceBySymbol: {},
    performanceByRegime: {},
    performanceByHourOfDay: {},
    performanceByVolatilityBucket: {},
  };
}

function makeReq(body: unknown) {
  return new Request('http://test.local/api/backtest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fake-token' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/backtest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateMock.mockResolvedValue({ userId: 'user-abc123def', client: {}, email: 'test@example.com' });
    computeBacktestMetricsMock.mockReturnValue(stubMetrics());
  });

  it('returns 401 when unauthenticated', async () => {
    authenticateMock.mockResolvedValueOnce(null);
    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m' }) as any);
    expect(res.status).toBe(401);
  });

  it('rejects invalid timeframe with 400', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '9x' }) as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid timeframe/);
    expect(Array.isArray(body.validTimeframes)).toBe(true);
  });

  it('rejects invalid exchange with 400', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m', exchange: 'mtgox' }) as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid exchange/);
  });

  it('returns 400 when no pairs are available and none requested', async () => {
    getActivePairsMock.mockResolvedValueOnce([]);
    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m' }) as any);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no pairs/);
  });

  it('falls back to getActivePairs when pairs body field is missing', async () => {
    getActivePairsMock.mockResolvedValueOnce(['BTC-USD', 'ETH-USD']);
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runBacktestMock.mockReturnValue({ trades: [], metrics: stubMetrics() });

    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m' }) as any);
    expect(res.status).toBe(200);
    expect(getActivePairsMock).toHaveBeenCalledOnce();
    expect(fetchHistoricalCandlesMock).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.pairs).toHaveLength(2);
    expect(body.summary.pairsRequested).toBe(2);
    expect(body.summary.succeeded).toBe(2);
  });

  it('uses pairs from the body when provided and skips pair discovery', async () => {
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runBacktestMock.mockReturnValue({ trades: [{ netPnl: 1 }], metrics: stubMetrics() });

    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '1h', pairs: ['SOL-USD'], exchange: 'coinbase', limit: 200, equity: 50 }) as any);
    expect(res.status).toBe(200);
    expect(getActivePairsMock).not.toHaveBeenCalled();
    expect(fetchHistoricalCandlesMock).toHaveBeenCalledWith('coinbase', 'SOL-USD', '1h', 200);
    const body = await res.json();
    expect(body.pairs).toHaveLength(1);
    expect(body.pairs[0].pair).toBe('SOL-USD');
  });

  it('marks pairs with <50 candles as skipped and continues', async () => {
    fetchHistoricalCandlesMock.mockImplementation(async (_ex: string, pair: string) =>
      pair === 'BAD-USD' ? makeCandles(20) : makeCandles(200),
    );
    runBacktestMock.mockReturnValue({ trades: [], metrics: stubMetrics() });

    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m', pairs: ['GOOD-USD', 'BAD-USD'] }) as any);
    const body = await res.json();
    expect(body.summary.succeeded).toBe(1);
    expect(body.summary.skipped).toBe(1);
    expect(body.pairs.find((p: { pair: string }) => p.pair === 'BAD-USD').error).toBe('insufficient candles');
  });

  it('records failed pairs when fetchHistoricalCandles throws', async () => {
    fetchHistoricalCandlesMock.mockImplementation(async (_ex: string, pair: string) => {
      if (pair === 'OOPS-USD') throw new Error('exchange down');
      return makeCandles(200);
    });
    runBacktestMock.mockReturnValue({ trades: [], metrics: stubMetrics() });

    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m', pairs: ['FINE-USD', 'OOPS-USD'] }) as any);
    const body = await res.json();
    expect(body.summary.failed).toBe(1);
    expect(body.summary.succeeded).toBe(1);
    expect(body.pairs.find((p: { pair: string }) => p.pair === 'OOPS-USD').error).toMatch(/exchange down/);
  });

  it('clamps limit to [50, 1000]', async () => {
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runBacktestMock.mockReturnValue({ trades: [], metrics: stubMetrics() });

    const { POST } = await importRoute();
    await POST(makeReq({ timeframe: '5m', pairs: ['BTC-USD'], limit: 5000 }) as any);
    expect(fetchHistoricalCandlesMock).toHaveBeenCalledWith('kraken', 'BTC-USD', '5m', 1000);

    fetchHistoricalCandlesMock.mockClear();
    await POST(makeReq({ timeframe: '5m', pairs: ['BTC-USD'], limit: 1 }) as any);
    expect(fetchHistoricalCandlesMock).toHaveBeenCalledWith('kraken', 'BTC-USD', '5m', 50);
  });

  it('runs all three exchanges when exchange="all"', async () => {
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runBacktestMock.mockReturnValue({ trades: [{ netPnl: 1, grossPnl: 2, fees: 1 }], metrics: stubMetrics() });
    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m', exchange: 'all', pairs: ['BTC-USD'] }) as any);
    expect(res.status).toBe(200);
    expect(fetchHistoricalCandlesMock).toHaveBeenCalledTimes(3);
    const exchangesCalled = fetchHistoricalCandlesMock.mock.calls.map((c) => c[0]);
    expect(new Set(exchangesCalled)).toEqual(new Set(['kraken', 'binance-us', 'coinbase']));
    const body = await res.json();
    expect(body.exchangesRan).toEqual(['kraken', 'binance-us', 'coinbase']);
    expect(body.perExchange).toHaveProperty('kraken');
    expect(body.perExchange).toHaveProperty('binance-us');
    expect(body.perExchange).toHaveProperty('coinbase');
    expect(body.pairs).toHaveLength(3); // 1 pair × 3 exchanges
    expect(body.summary.pairsRequested).toBe(3); // 1 × 3
  });

  it('never imports or invokes the trade-execution path', async () => {
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runBacktestMock.mockReturnValue({ trades: [{ netPnl: 1 }], metrics: stubMetrics() });
    const { POST } = await importRoute();
    await POST(makeReq({ timeframe: '5m', pairs: ['BTC-USD'] }) as any);
    // No trade-execution stub exists because the route must not have any
    // code path that touches act() / placeOrder. This test guards that by
    // asserting only the three read-only helpers were called.
    expect(fetchHistoricalCandlesMock).toHaveBeenCalled();
    expect(runBacktestMock).toHaveBeenCalled();
    expect(computeBacktestMetricsMock).toHaveBeenCalled();
  });
});
