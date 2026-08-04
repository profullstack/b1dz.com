import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const cryptoCosts = { feeBps: 60, slippageBps: 5, assumedHalfSpreadBps: 5, perOrderUsd: 0, roundTripBps: 140 };
const cryptoClass = {
  assetClass: 'crypto',
  basket: ['BTC-USD'],
  symbols: ['BTC-USD'],
  trades: 4,
  returnPct: 0.08,
  grossReturnPct: 0.14,
  winRate: 0.5,
  profit: 80,
  maxDrawdown: 30,
  bankroll: 1000,
  finalEquity: 1080,
  feesUsd: 48,
  spreadSlippageUsd: 12,
  totalCostUsd: 60,
  costDragPct: 0.06,
  costs: cryptoCosts,
};

describe('POST /api/strategies/backtest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateMock.mockResolvedValue({ userId: 'u1', client: {}, email: 'a@b.c' });
    validateMock.mockReturnValue({ ok: true, errors: [] });
    compileMock.mockReturnValue({ manifest: { id: 'x', name: 'X' } });
    runBacktestMock.mockResolvedValue({
      bankroll: 1000, timeframe: '1 year', startYmd: '2025-06-30', endYmd: '2026-06-30',
      classes: [cryptoClass], verdict: null,
    });
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

  it('returns the resolved cost assumptions and the net-vs-gross pair per class', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeReq({ definition: validDoc }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.costsOverridden).toBe(false);
    const cls = body.classes[0];
    expect(cls.costs).toEqual(cryptoCosts);
    expect(cls.grossReturnPct).toBeGreaterThan(cls.returnPct);
    expect(cls.feesUsd + cls.spreadSlippageUsd).toBeCloseTo(cls.totalCostUsd);
    expect(cls.costDragPct).toBeCloseTo(cls.grossReturnPct - cls.returnPct, 10);
  });

  it('leaves costs undefined when the body omits them (per-class defaults apply)', async () => {
    const { POST } = await importRoute();
    await POST(makeReq({ definition: validDoc }) as never);
    const [, opts] = runBacktestMock.mock.calls[0]!;
    expect(opts.costs).toBeUndefined();
  });

  it('passes a valid cost override through, defaulting omitted fields to zero', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeReq({ definition: validDoc, costs: { feeBps: 26, slippageBps: 3 } }) as never);
    expect(res.status).toBe(200);
    const [, opts] = runBacktestMock.mock.calls[0]!;
    expect(opts.costs).toEqual({ feeBps: 26, slippageBps: 3, assumedHalfSpreadBps: 0, perOrderUsd: 0 });
    expect((await res.json()).costsOverridden).toBe(true);
  });

  it('accepts an explicit all-zero override (the frictionless comparison run)', async () => {
    const { POST } = await importRoute();
    const res = await POST(
      makeReq({ definition: validDoc, costs: { feeBps: 0, slippageBps: 0, assumedHalfSpreadBps: 0, perOrderUsd: 0 } }) as never,
    );
    expect(res.status).toBe(200);
    const [, opts] = runBacktestMock.mock.calls[0]!;
    expect(opts.costs).toEqual({ feeBps: 0, slippageBps: 0, assumedHalfSpreadBps: 0, perOrderUsd: 0 });
  });

  it.each([
    ['above the bps ceiling', { feeBps: 501 }],
    ['negative', { slippageBps: -1 }],
    ['a non-number', { assumedHalfSpreadBps: '5' }],
    ['not finite', { feeBps: Number.POSITIVE_INFINITY }],
    ['above the per-order ceiling', { perOrderUsd: 100.5 }],
    ['an unknown field', { gasBps: 5 }],
  ])('400 when the cost override is %s', async (_label, costs) => {
    const { POST } = await importRoute();
    const res = await POST(makeReq({ definition: validDoc, costs }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/cost override/);
    expect(body.details.length).toBeGreaterThan(0);
    expect(runBacktestMock).not.toHaveBeenCalled();
  });

  it.each([['an array', []], ['a string', 'cheap'], ['a number', 5]])(
    '400 when costs is %s rather than an object',
    async (_label, costs) => {
      const { POST } = await importRoute();
      const res = await POST(makeReq({ definition: validDoc, costs }) as never);
      expect(res.status).toBe(400);
      expect((await res.json()).details).toEqual(['costs must be an object']);
    },
  );

  it('treats an explicit null costs as "use the defaults"', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeReq({ definition: validDoc, costs: null }) as never);
    expect(res.status).toBe(200);
    const [, opts] = runBacktestMock.mock.calls[0]!;
    expect(opts.costs).toBeUndefined();
  });

  it('names every offending field rather than stopping at the first', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeReq({ definition: validDoc, costs: { feeBps: 900, slippageBps: -2 } }) as never);
    expect(res.status).toBe(400);
    const details = (await res.json()).details as string[];
    expect(details.some((d) => d.includes('feeBps'))).toBe(true);
    expect(details.some((d) => d.includes('slippageBps'))).toBe(true);
  });
});
