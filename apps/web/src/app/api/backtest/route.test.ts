import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticateMock = vi.fn();
const unauthorizedMock = vi.fn(() => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
const fetchHistoricalCandlesMock = vi.fn();
const runMultiPairBacktestMock = vi.fn();
const computeBacktestMetricsMock = vi.fn();
const getActivePairsMock = vi.fn();

// Supabase client mock used for DB persistence. The route inserts into
// backtest_runs and backtest_trades; we return a fake runId.
const insertRunsMock = vi.fn();
const insertTradesMock = vi.fn();
function makeSupabaseClient() {
  return {
    from: vi.fn((table: string) => {
      if (table === 'backtest_runs') {
        return {
          insert: (row: unknown) => ({
            select: () => ({
              single: async () => insertRunsMock(row),
            }),
          }),
        };
      }
      if (table === 'backtest_trades') {
        return {
          insert: async (rows: unknown) => insertTradesMock(rows),
        };
      }
      return {} as any;
    }),
  };
}

vi.mock('@/lib/api-auth', () => ({
  authenticate: authenticateMock,
  unauthorized: unauthorizedMock,
}));

vi.mock('@b1dz/source-crypto-trade', () => ({
  fetchHistoricalCandles: fetchHistoricalCandlesMock,
  runMultiPairBacktest: runMultiPairBacktestMock,
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

function stubTrade(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTC-USD',
    exchange: 'kraken',
    direction: 'long' as const,
    regime: 'uptrend' as const,
    setupType: 'long_trend_continuation' as const,
    score: 85,
    entryTime: 1_700_000_000_000,
    exitTime: 1_700_000_600_000,
    entryPrice: 100,
    exitPrice: 100.8,
    stopLoss: 99.6,
    takeProfit: 100.8,
    grossPnl: 0.8,
    fees: 0.2,
    slippageCost: 0.01,
    netPnl: 0.6,
    holdMinutes: 10,
    hourOfDay: 14,
    volatilityBucket: 'medium' as const,
    ...overrides,
  };
}

function stubMultiResult(trades: ReturnType<typeof stubTrade>[] = [], signalsSkipped = 0) {
  const perPair: Record<string, { trades: number; netPnl: number; candles: number }> = {};
  for (const t of trades) {
    const bucket = perPair[t.symbol] ?? (perPair[t.symbol] = { trades: 0, netPnl: 0, candles: 200 });
    bucket.trades++;
    bucket.netPnl += t.netPnl;
  }
  return {
    trades,
    metrics: stubMetrics(),
    haltedByDailyLossLimit: false,
    signalsSkippedForOpenPosition: signalsSkipped,
    perPair,
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
    authenticateMock.mockResolvedValue({
      userId: 'user-abc123def',
      client: makeSupabaseClient(),
      email: 'test@example.com',
    });
    computeBacktestMetricsMock.mockReturnValue(stubMetrics());
    insertRunsMock.mockResolvedValue({ data: { id: 'run-123' }, error: null });
    insertTradesMock.mockResolvedValue({ error: null });
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

  it('runs a multi-pair backtest and persists the run to the DB', async () => {
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runMultiPairBacktestMock.mockReturnValue(stubMultiResult([stubTrade({ symbol: 'BTC-USD' }), stubTrade({ symbol: 'ETH-USD' })]));

    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '1h', pairs: ['BTC-USD', 'ETH-USD'] }) as any);
    expect(res.status).toBe(200);

    expect(runMultiPairBacktestMock).toHaveBeenCalledOnce();
    const arg = runMultiPairBacktestMock.mock.calls[0]![0] as { exchange: string; pairs: Array<{ symbol: string }> };
    expect(arg.exchange).toBe('kraken');
    expect(arg.pairs.map((p) => p.symbol)).toEqual(['BTC-USD', 'ETH-USD']);

    // Persistence path
    expect(insertRunsMock).toHaveBeenCalledOnce();
    const runRow = insertRunsMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(runRow.user_id).toBe('user-abc123def');
    expect(runRow.timeframe).toBe('1h');
    expect(runRow.exchange).toBe('kraken');
    expect(runRow.total_trades).toBe(2);

    expect(insertTradesMock).toHaveBeenCalledOnce();
    const tradesRows = insertTradesMock.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(tradesRows).toHaveLength(2);
    expect(tradesRows[0]!.run_id).toBe('run-123');
    expect(tradesRows[0]!.user_id).toBe('user-abc123def');

    const body = await res.json();
    expect(body.runId).toBe('run-123');
  });

  it('falls back to getActivePairs when pairs field is missing', async () => {
    getActivePairsMock.mockResolvedValueOnce(['BTC-USD', 'ETH-USD']);
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runMultiPairBacktestMock.mockReturnValue(stubMultiResult([]));

    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m' }) as any);
    expect(res.status).toBe(200);
    expect(getActivePairsMock).toHaveBeenCalledOnce();
    expect(fetchHistoricalCandlesMock).toHaveBeenCalledTimes(2);
  });

  it('marks pairs with <50 candles as skipped and excludes them from the simulation', async () => {
    fetchHistoricalCandlesMock.mockImplementation(async (_ex: string, pair: string) =>
      pair === 'BAD-USD' ? makeCandles(20) : makeCandles(200),
    );
    runMultiPairBacktestMock.mockReturnValue(stubMultiResult([]));

    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m', pairs: ['GOOD-USD', 'BAD-USD'] }) as any);
    const body = await res.json();
    expect(body.summary.skipped).toBe(1);
    expect(body.pairs.find((p: { pair: string }) => p.pair === 'BAD-USD').error).toBe('insufficient candles');
    // Only the usable pair should be passed to the simulator.
    const arg = runMultiPairBacktestMock.mock.calls[0]![0] as { pairs: Array<{ symbol: string }> };
    expect(arg.pairs.map((p) => p.symbol)).toEqual(['GOOD-USD']);
  });

  it('records failed pairs when fetchHistoricalCandles throws', async () => {
    fetchHistoricalCandlesMock.mockImplementation(async (_ex: string, pair: string) => {
      if (pair === 'OOPS-USD') throw new Error('exchange down');
      return makeCandles(200);
    });
    runMultiPairBacktestMock.mockReturnValue(stubMultiResult([]));

    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m', pairs: ['FINE-USD', 'OOPS-USD'] }) as any);
    const body = await res.json();
    expect(body.summary.failed).toBe(1);
    expect(body.pairs.find((p: { pair: string }) => p.pair === 'OOPS-USD').error).toMatch(/exchange down/);
  });

  it('clamps limit to [50, 1000]', async () => {
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runMultiPairBacktestMock.mockReturnValue(stubMultiResult([]));

    const { POST } = await importRoute();
    await POST(makeReq({ timeframe: '5m', pairs: ['BTC-USD'], limit: 5000 }) as any);
    expect(fetchHistoricalCandlesMock).toHaveBeenCalledWith('kraken', 'BTC-USD', '5m', 1000);

    fetchHistoricalCandlesMock.mockClear();
    await POST(makeReq({ timeframe: '5m', pairs: ['BTC-USD'], limit: 1 }) as any);
    expect(fetchHistoricalCandlesMock).toHaveBeenCalledWith('kraken', 'BTC-USD', '5m', 50);
  });

  it('runs all three exchanges when exchange="all"', async () => {
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runMultiPairBacktestMock.mockReturnValue(stubMultiResult([stubTrade()]));
    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m', exchange: 'all', pairs: ['BTC-USD'] }) as any);
    expect(res.status).toBe(200);
    expect(runMultiPairBacktestMock).toHaveBeenCalledTimes(3);
    const exchangesCalled = runMultiPairBacktestMock.mock.calls.map((c) => (c[0] as { exchange: string }).exchange);
    expect(new Set(exchangesCalled)).toEqual(new Set(['kraken', 'binance-us', 'coinbase']));
    const body = await res.json();
    expect(body.exchangesRan).toEqual(['kraken', 'binance-us', 'coinbase']);
  });

  it('exposes signalsSkippedForOpenPosition in the aggregate', async () => {
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runMultiPairBacktestMock.mockReturnValue(stubMultiResult([stubTrade()], 42));
    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m', pairs: ['BTC-USD'] }) as any);
    const body = await res.json();
    expect(body.aggregate.signalsSkippedForOpenPosition).toBe(42);
  });

  it('never imports or invokes the trade-execution path', async () => {
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runMultiPairBacktestMock.mockReturnValue(stubMultiResult([]));
    const { POST } = await importRoute();
    await POST(makeReq({ timeframe: '5m', pairs: ['BTC-USD'] }) as any);
    expect(fetchHistoricalCandlesMock).toHaveBeenCalled();
    expect(runMultiPairBacktestMock).toHaveBeenCalled();
    expect(computeBacktestMetricsMock).toHaveBeenCalled();
  });

  it('still returns 200 even when DB persistence fails (logs error)', async () => {
    fetchHistoricalCandlesMock.mockResolvedValue(makeCandles(200));
    runMultiPairBacktestMock.mockReturnValue(stubMultiResult([stubTrade()]));
    insertRunsMock.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });
    const { POST } = await importRoute();
    const res = await POST(makeReq({ timeframe: '5m', pairs: ['BTC-USD'] }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBeNull();
  });
});
