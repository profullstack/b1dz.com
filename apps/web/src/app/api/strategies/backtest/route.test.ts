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
