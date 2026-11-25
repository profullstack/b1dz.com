import { describe, expect, it } from 'vitest';
import { Http } from '../http.js';
import { createContext } from '../registry.js';
import { CDE, CDE_NOTE, cdeBars, cdeChain, cdeContract, cdeCovers, futuresNotes, futuresRoot, parseCdeCandles, parseCdeProducts } from './exchange-futures.js';
import { getHistory, getQuote } from './market.js';
import { NICHEDB, nichedbBars, nichedbTag, parseNichedbHistory } from './nichedb.js';

const NOW = new Date('2026-11-25T00:30:00Z');

// Shaped like GET api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE
const product = (id: string, unit: string, expiry: string, month: string, price: string, pct: string, label: string, extra: Record<string, unknown> = {}) => ({
  product_id: id,
  price,
  price_percentage_change_24h: pct,
  volume_24h: '9841',
  is_disabled: false,
  product_type: 'FUTURE',
  future_product_details: { venue: 'cde', contract_root_unit: unit, contract_expiry: expiry, contract_expiry_name: month, contract_display_name: label, display_name: `${label} full`, open_interest: '5747' },
  ...extra,
});
const PRODUCTS = {
  products: [
    product('NOL-19FEB27-CDE', 'CDEOIL', '2027-02-19T19:30:00Z', '2027-03', '', '', 'OIL 19-Feb 27'),
    product('NOL-18DEC26-CDE', 'CDEOIL', '2026-12-18T19:30:00Z', '2027-01', '81.73', '1.59105034182722', 'OIL 18-Dec'),
    product('NOL-19JAN27-CDE', 'CDEOIL', '2027-01-19T19:30:00Z', '2027-02', '80.41', '0.7644', 'OIL 19-Jan 27'),
    product('GOL-24NOV26-CDE', 'CDEGLD', '2026-11-24T19:00:00Z', '2026-12', '3540', '-2.7', 'GLD 24-Nov'),
    product('GOL-27JAN27-CDE', 'CDEGLD', '2027-01-27T19:00:00Z', '2027-02', '3571.1', '-2.806', 'GLD 27-Jan 27'),
    product('BIP-20DEC30-CDE', 'BTC', '2089-12-30T00:00:00Z', '2089-12', '59485', '-2.826', 'BTC Perp'),
    product('BIT-27NOV26-CDE', 'BTC', '2026-11-27T16:00:00Z', '2026-11', '59490', '-2.849', 'BTC 27-Nov'),
    product('OLD-01JAN27-CDE', 'CDEOIL', '2027-01-01T00:00:00Z', '2027-01', '70', '0', 'OIL disabled', { is_disabled: true }),
    { product_id: 'BROKEN' },
  ],
};
const CANDLES = {
  candles: [
    { start: '1795564800', low: '81.66', high: '81.73', open: '81.66', close: '81.73', volume: '9.0' },
    { start: '1795478400', low: '79.15', high: '82.11', open: '80.51', close: '81.69', volume: '9876.0' },
    { start: 'x', low: '1', high: '1', open: '1', close: '1', volume: '1' },
  ],
};
const HISTORY = {
  count: 1,
  items: [{ data: { symbol: 'AAPL', feed: 'iex', bars: [['2026-11-20', 345, 350, 344, 347.5, 1000, 347.1], ['2026-11-23', 347.87, 352.6, 345.44, 349.08, 58588700, null], ['bad', 1, 1, 1, 1, 1], ['2026-11-19', 340, 346, 339, 345, 900]] } }],
};

function ctxWith(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response('Too Many Requests', { status: 429 });
    return new Response(typeof hit[1].body === 'string' ? hit[1].body : JSON.stringify(hit[1].body), { status: hit[1].status ?? 200 });
  }) as typeof fetch;
  return { ctx: createContext({ http: new Http({ fetch: impl, hostGapMs: 0 }), env: {}, now: () => NOW }), calls };
}

describe('futures symbols', () => {
  it('reads front-month and dated symbols', () => {
    expect(futuresRoot('CL=F')).toEqual({ root: 'CL' });
    expect(futuresRoot('cl=f')).toEqual({ root: 'CL' });
    expect(futuresRoot('CLF27.NYM')).toEqual({ root: 'CL', month: '2027-01' });
    expect(futuresRoot('ZQZ26.CBT')).toEqual({ root: 'ZQ', month: '2026-12' });
    expect(futuresRoot('HGH27.CMX')).toEqual({ root: 'HG', month: '2027-03' });
    expect(futuresRoot('GCG27.CMX')).toEqual({ root: 'GC', month: '2027-02' });
    expect(futuresRoot('6E=F')).toEqual({ root: '6E' });
    expect(futuresRoot('AAPL')).toBeNull();
    expect(futuresRoot('EURUSD=X')).toBeNull();
  });

  it('knows which roots Coinbase lists', () => {
    expect(cdeCovers('CL=F')).toBe(true);
    expect(cdeCovers('GCG27.CMX')).toBe(true);
    expect(cdeCovers('ES=F')).toBe(false);
    expect(cdeCovers('ZC=F')).toBe(false);
    expect(cdeCovers('SPY')).toBe(false);
  });
});

describe('Coinbase Derivatives parsing', () => {
  it('parses products, sorted by expiry, dropping disabled and malformed rows', () => {
    const all = parseCdeProducts(PRODUCTS);
    expect(all.map((c) => c.id)).toEqual(['GOL-24NOV26-CDE', 'BIT-27NOV26-CDE', 'NOL-18DEC26-CDE', 'NOL-19JAN27-CDE', 'GOL-27JAN27-CDE', 'NOL-19FEB27-CDE', 'BIP-20DEC30-CDE']);
    const oil = all.find((c) => c.id === 'NOL-18DEC26-CDE')!;
    expect(oil).toMatchObject({ unit: 'CDEOIL', month: '2027-01', price: 81.73, volume: 9841, openInterest: 5747, perpetual: false });
    expect(oil.changePct).toBeCloseTo(1.591, 3);
    expect(all.find((c) => c.id === 'NOL-19FEB27-CDE')).toMatchObject({ price: null, changePct: null });
    expect(all.find((c) => c.id === 'BIP-20DEC30-CDE')?.perpetual).toBe(true);
    expect(parseCdeProducts({})).toEqual([]);
    expect(parseCdeProducts(null)).toEqual([]);
  });

  it('parses candles oldest first and skips bad rows', () => {
    expect(parseCdeCandles(CANDLES)).toEqual([
      { t: 1795478400000, o: 80.51, h: 82.11, l: 79.15, c: 81.69, v: 9876 },
      { t: 1795564800000, o: 81.66, h: 81.73, l: 81.66, c: 81.73, v: 9 },
    ]);
    expect(parseCdeCandles({ error: 'x' })).toEqual([]);
  });

  it('picks the nearest traded contract for a front-month symbol, skipping expired and perpetual ones', async () => {
    const { ctx } = ctxWith({ 'product_type=FUTURE': { body: PRODUCTS } });
    expect((await cdeContract(ctx, 'CL=F')).id).toBe('NOL-18DEC26-CDE');
    // The November gold contract expired yesterday; the January one is the front.
    expect((await cdeContract(ctx, 'GC=F')).id).toBe('GOL-27JAN27-CDE');
    expect((await cdeContract(ctx, 'BTC=F')).id).toBe('BIT-27NOV26-CDE');
    expect((await cdeChain(ctx, 'CL')).map((c) => c.month)).toEqual(['2027-01', '2027-02', '2027-03']);
  });

  it('maps a dated symbol by delivery month and refuses months it cannot price', async () => {
    const { ctx } = ctxWith({ 'product_type=FUTURE': { body: PRODUCTS } });
    expect((await cdeContract(ctx, 'CLG27.NYM')).id).toBe('NOL-19JAN27-CDE');
    await expect(cdeContract(ctx, 'CLH27.NYM')).rejects.toThrow('has not traded yet');
    await expect(cdeContract(ctx, 'CLZ27.NYM')).rejects.toThrow('no CL contract for 2027-12');
    await expect(cdeContract(ctx, 'ES=F')).rejects.toThrow('no contract for ES=F');
  });

  it('fetches candles for the resolved contract', async () => {
    const { ctx, calls } = ctxWith({ 'product_type=FUTURE': { body: PRODUCTS }, '/candles': { body: CANDLES } });
    const { bars, contract } = await cdeBars(ctx, 'CL=F', new Date('2020-01-01T00:00:00Z'), NOW);
    expect(contract.id).toBe('NOL-18DEC26-CDE');
    expect(bars).toHaveLength(2);
    const url = new URL(calls.find((c) => c.includes('/candles'))!);
    expect(url.pathname).toContain('/products/NOL-18DEC26-CDE/candles');
    // Never asks for more than the API's 350-candle window.
    expect(Number(url.searchParams.get('end')) - Number(url.searchParams.get('start'))).toBeLessThanOrEqual(340 * 86_400);
    expect(url.searchParams.get('granularity')).toBe('ONE_DAY');
  });

  it('writes notes for the venue that answered', () => {
    expect(futuresNotes(CDE, 'delayed')).toEqual([CDE_NOTE]);
    expect(futuresNotes('Yahoo Finance', 'delayed')).toEqual(['delayed']);
    expect(futuresNotes(`${CDE}, Yahoo Finance`, 'delayed')).toEqual(['delayed', CDE_NOTE]);
    expect(futuresNotes('', 'delayed')).toEqual(['delayed']);
  });
});

describe('NicheDB history', () => {
  it('tags symbols the way nichedb stores them', () => {
    expect(nichedbTag(' BRK-B ')).toBe('symbol:brk.b');
    expect(nichedbTag('AAPL')).toBe('symbol:aapl');
  });

  it('parses bar tuples oldest first, dropping malformed rows', () => {
    const bars = parseNichedbHistory(HISTORY);
    expect(bars.map((b) => new Date(b.t).toISOString().slice(0, 10))).toEqual(['2026-11-19', '2026-11-20', '2026-11-23']);
    expect(bars[2]).toEqual({ t: Date.UTC(2026, 10, 23), o: 347.87, h: 352.6, l: 345.44, c: 349.08, v: 58588700 });
    expect(parseNichedbHistory({ items: [] })).toEqual([]);
  });

  it('refuses a missing or stale history', async () => {
    await expect(nichedbBars(ctxWith({ 'nichedb.dev': { body: { items: [] } } }).ctx, 'ZZZZ')).rejects.toThrow('no history for ZZZZ');
    const stale = { items: [{ data: { bars: [['2026-10-01', 1, 1, 1, 1, 1]] } }] };
    await expect(nichedbBars(ctxWith({ 'nichedb.dev': { body: stale } }).ctx, 'OLD')).rejects.toThrow('stale');
    const { ctx, calls } = ctxWith({ 'nichedb.dev': { body: HISTORY } });
    expect(await nichedbBars(ctx, 'AAPL')).toHaveLength(3);
    expect(calls[0]).toContain('collection=markets&kind=history&tags=symbol%3Aaapl&limit=1');
  });
});

describe('market provider chain', () => {
  it('prices a commodity future from Coinbase Derivatives before trying Yahoo', async () => {
    const { ctx, calls } = ctxWith({ 'product_type=FUTURE': { body: PRODUCTS } });
    const q = await getQuote(ctx, 'CL=F');
    expect(q).toMatchObject({ symbol: 'CL=F', price: 81.73, source: CDE, currency: 'USD' });
    expect(q.changePct).toBeCloseTo(1.591, 3);
    expect(q.prevClose).toBeCloseTo(81.73 / 1.0159105, 4);
    expect(q.change).toBeCloseTo(81.73 - 81.73 / 1.0159105, 4);
    expect(calls.some((c) => c.includes('yahoo'))).toBe(false);
  });

  it('still falls through to Yahoo for futures Coinbase does not list', async () => {
    const { ctx, calls } = ctxWith({ 'product_type=FUTURE': { body: PRODUCTS } });
    await expect(getQuote(ctx, 'ES=F')).rejects.toThrow(/Yahoo/);
    expect(calls.some((c) => c.includes('coinbase'))).toBe(false);
  });

  it('serves futures history from Coinbase candles', async () => {
    const { ctx } = ctxWith({ 'product_type=FUTURE': { body: PRODUCTS }, '/candles': { body: CANDLES } });
    const h = await getHistory(ctx, 'CL=F', '3M');
    expect(h.source).toBe(CDE);
    expect(h.bars.map((b) => b.c)).toEqual([81.69, 81.73]);
  });

  it('uses NicheDB for a U.S. stock when Nasdaq fails, for history and for a quote', async () => {
    const { ctx } = ctxWith({ 'api.nasdaq.com': { status: 503, body: 'down' }, 'nichedb.dev': { body: HISTORY } });
    const h = await getHistory(ctx, 'AAPL', '1M');
    expect(h.source).toBe(NICHEDB);
    expect(h.bars).toHaveLength(3);
    const q = await getQuote(ctx, 'AAPL');
    expect(q).toMatchObject({ price: 349.08, prevClose: 347.5, source: NICHEDB, currency: 'USD' });
    expect(q.changePct).toBeCloseTo(((349.08 - 347.5) / 347.5) * 100, 6);
  });

  it('does not ask NicheDB about listings outside the U.S.', async () => {
    const { ctx, calls } = ctxWith({ 'nichedb.dev': { body: HISTORY } });
    await expect(getHistory(ctx, 'SHEL.L', '1M')).rejects.toThrow();
    expect(calls.some((c) => c.includes('nichedb'))).toBe(false);
  });
});
