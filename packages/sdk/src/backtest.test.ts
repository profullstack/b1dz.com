import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { B1dzClient } from './index.js';

function makeJwt(expOffsetSec: number) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: now + expOffsetSec })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const BASE_URL = 'https://api.b1dz.test';
const accessToken = makeJwt(3600);
const refreshToken = 'refresh-ok';

const FAKE_RESPONSE = {
  timeframe: '5m',
  exchange: 'kraken',
  limit: 500,
  equity: 100,
  pairs: [
    {
      pair: 'BTC-USD',
      candles: 500,
      result: {
        trades: [{ netPnl: 2.5 }, { netPnl: -1.1 }],
        metrics: {
          totalReturn: 1.4,
          winRate: 50,
          profitFactor: 2.27,
          expectancy: 0.7,
          maxDrawdown: 3.2,
          sharpe: 0.6,
          averageHoldMinutes: 25,
          tradesPerDay: 4,
          performanceBySymbol: { 'BTC-USD': { trades: 2, netPnl: 1.4, wins: 1, losses: 1 } },
          performanceByRegime: { uptrend: { trades: 2, netPnl: 1.4, wins: 1, losses: 1 } },
          performanceByHourOfDay: { '14': { trades: 2, netPnl: 1.4, wins: 1, losses: 1 } },
          performanceByVolatilityBucket: { medium: { trades: 2, netPnl: 1.4, wins: 1, losses: 1 } },
        },
      },
      error: null,
    },
  ],
  aggregate: {
    trades: 2,
    candles: 500,
    metrics: {
      totalReturn: 1.4,
      winRate: 50,
      profitFactor: 2.27,
      expectancy: 0.7,
      maxDrawdown: 3.2,
      sharpe: 0.6,
      averageHoldMinutes: 25,
      tradesPerDay: 4,
      performanceBySymbol: {},
      performanceByRegime: {},
      performanceByHourOfDay: {},
      performanceByVolatilityBucket: {},
    },
  },
  summary: { succeeded: 1, skipped: 0, failed: 0, pairsRequested: 1, durationMs: 1234 },
};

describe('B1dzClient.backtest.run', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify(FAKE_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-b1dz-version': 'test-api' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeClient() {
    return new B1dzClient({
      baseUrl: BASE_URL,
      tokens: { accessToken, refreshToken },
    });
  }

  it('POSTs to /api/backtest with the provided options as JSON', async () => {
    const client = makeClient();
    await client.backtest.run({
      timeframe: '1h',
      pairs: ['BTC-USD', 'ETH-USD'],
      exchange: 'kraken',
      limit: 300,
      equity: 250,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${BASE_URL}/api/backtest`);
    expect(calledInit.method).toBe('POST');
    const headers = calledInit.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${accessToken}`);
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(calledInit.body as string)).toEqual({
      timeframe: '1h',
      pairs: ['BTC-USD', 'ETH-USD'],
      exchange: 'kraken',
      limit: 300,
      equity: 250,
    });
  });

  it('returns the parsed JSON response body', async () => {
    const client = makeClient();
    const result = await client.backtest.run({ timeframe: '5m' });
    expect(result).toEqual(FAKE_RESPONSE);
    expect(result.aggregate.trades).toBe(2);
    expect(result.pairs[0]?.pair).toBe('BTC-USD');
    expect(result.summary.succeeded).toBe(1);
  });

  it('propagates API error responses as thrown errors', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(
      JSON.stringify({ error: 'invalid timeframe "9x"' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    const client = makeClient();
    await expect(client.backtest.run({ timeframe: '5m' })).rejects.toThrow(/400/);
  });

  it('captures the x-b1dz-version header from responses', async () => {
    const client = makeClient();
    await client.backtest.run({ timeframe: '5m' });
    expect(client.getApiVersion()).toBe('test-api');
  });
});
