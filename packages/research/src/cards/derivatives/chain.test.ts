import { describe, expect, it } from 'vitest';
import {
  atmIv,
  atmStrike,
  cryptoCurrency,
  daysTo,
  enrichChain,
  impliedForwards,
  isLastFriday,
  isThirdFriday,
  midPrice,
  monthlyExpiries,
  otmSmile,
  parseCboeChain,
  parseLongDate,
  parseNasdaqChain,
  parseOccSymbol,
  parseTmxPage,
  pickExpiry,
  usableMid,
  yearsTo,
  type RawChain,
  type RawQuote,
} from './chain.js';
import { black76Price, bsPrice } from './optionmath.js';

describe('parseLongDate', () => {
  it('reads long and abbreviated month names', () => {
    expect(parseLongDate('December 18, 2026')).toBe('2026-12-18');
    expect(parseLongDate('LAST TRADE: $349.08 (AS OF NOV 24, 2026)')).toBe('2026-11-24');
    expect(parseLongDate('January 2, 2027 (Weekly)')).toBe('2027-01-02');
    expect(parseLongDate('nothing here')).toBeNull();
  });
});

describe('parseNasdaqChain', () => {
  const body = {
    data: {
      totalRecord: 3,
      lastTrade: 'LAST TRADE: $1,349.08 (AS OF NOV 24, 2026)',
      table: {
        rows: [
          { expirygroup: 'December 18, 2026', expiryDate: null, strike: null },
          { expirygroup: '', expiryDate: 'Dec 18', c_Last: '9.60', c_Bid: '8.00', c_Ask: '9.25', c_Volume: '2,512', c_Openinterest: '30614', strike: '1,350.00', p_Last: '--', p_Bid: '--', p_Ask: '10.90', p_Volume: '--', p_Openinterest: '--' },
          { expirygroup: 'January 15, 2027', expiryDate: null, strike: null },
          { expirygroup: '', expiryDate: 'Jan 15', c_Last: '15.10', c_Bid: '14.00', c_Ask: '15.00', c_Volume: '3', c_Openinterest: '7', strike: '1,350.00', p_Last: '12.00', p_Bid: '11.00', p_Ask: '12.50', p_Volume: '1', p_Openinterest: '2' },
        ],
      },
    },
  };

  it('carries each group header down to its rows and splits calls from puts', () => {
    const out = parseNasdaqChain(body);
    expect(out.spot).toBe(1349.08);
    expect(out.asOf).toBe('2026-11-24');
    expect(out.quotes).toHaveLength(4);
    expect(out.quotes[0]).toEqual({ expiry: '2026-12-18', strike: 1350, type: 'C', bid: 8, ask: 9.25, last: 9.6, volume: 2512, oi: 30614 });
    expect(out.quotes[1]).toEqual({ expiry: '2026-12-18', strike: 1350, type: 'P', bid: null, ask: 10.9, last: null, volume: null, oi: null });
    expect(out.quotes[3].expiry).toBe('2027-01-15');
  });

  it('returns nothing for an error body', () => {
    const out = parseNasdaqChain({ data: null, status: { rCode: 400, bCodeMessage: [{ errorMessage: 'Symbol not exists.' }] } });
    expect(out.quotes).toEqual([]);
    expect(out.spot).toBeNull();
  });
});

describe('Cboe delayed quotes', () => {
  it('splits OCC symbols', () => {
    expect(parseOccSymbol('AAPL261218C00150000')).toEqual({ root: 'AAPL', expiry: '2026-12-18', type: 'C', strike: 150 });
    expect(parseOccSymbol('BRKB270115P00412500')).toEqual({ root: 'BRKB', expiry: '2027-01-15', type: 'P', strike: 412.5 });
    expect(parseOccSymbol('not a symbol')).toBeNull();
  });

  it('parses the options array', () => {
    const out = parseCboeChain({
      timestamp: '2026-11-24 15:10:02',
      data: {
        current_price: 349.5,
        options: [
          { option: 'AAPL261218C00350000', bid: 8, ask: 9.2, iv: 0.2456, open_interest: 30614, volume: 2512, last_trade_price: 9.6 },
          { option: 'AAPL261218P00350000', bid: 0, ask: 0, iv: 0, open_interest: 0, volume: 0, last_trade_price: 0 },
          { option: 'garbage' },
        ],
      },
    });
    expect(out.spot).toBe(349.5);
    expect(out.asOf).toBe('2026-11-24T15:10:02');
    expect(out.quotes).toEqual([
      { expiry: '2026-12-18', strike: 350, type: 'C', bid: 8, ask: 9.2, last: 9.6, volume: 2512, oi: 30614, ivGiven: 0.2456 },
      { expiry: '2026-12-18', strike: 350, type: 'P', bid: null, ask: null, last: null, volume: 0, oi: 0, ivGiven: null },
    ]);
  });
});

describe('parseTmxPage', () => {
  const row = (strike: number): string =>
    JSON.stringify({
      call: { expiry_date: '2026-12-18', strike_price: strike, last_price: 6.8, volume: 4, bid_price: 6.5, ask_price: 7, open_interest: 731, is_option: 1, volatility: 23.5 },
      put: { expiry_date: '2026-12-18', strike_price: strike, last_price: 0, volume: 0, bid_price: 0, ask_price: 0, open_interest: 224, is_option: 1, volatility: 0 },
    }).replace(/"/g, '&quot;');
  const page = (last: string): string => `<div class="quote-info">
<p>Last update: <b>November&nbsp;24,&nbsp;2026&nbsp;at&nbsp;8:46&nbsp;a.m.</b></p>
<ul><li>Last price: <b>${last}</b></li><li>Bid price: <b>270.500</b></li><li>Ask price: <b>270.540</b></li></ul></div>
<table><tr class="parent" data-row='${row(270)}'><td>x</td></tr><tr data-row='not json'></tr></table>`;

  it('reads quotes from the row attributes and the underlying from the header', () => {
    const out = parseTmxPage(page('271.80'));
    expect(out.spot).toBe(271.8);
    expect(out.asOf).toBe('2026-11-24');
    expect(out.quotes).toEqual([
      { expiry: '2026-12-18', strike: 270, type: 'C', bid: 6.5, ask: 7, last: 6.8, volume: 4, oi: 731, ivGiven: 0.235 },
      { expiry: '2026-12-18', strike: 270, type: 'P', bid: null, ask: null, last: null, volume: 0, oi: 224, ivGiven: null },
    ]);
  });

  it('uses the bid/ask midpoint of the underlying before the open', () => {
    expect(parseTmxPage(page('0')).spot).toBeCloseTo(270.52, 6);
  });
});

describe('quote helpers', () => {
  it('needs a two-sided, uncrossed market for a mid', () => {
    expect(midPrice(1, 2)).toBe(1.5);
    expect(midPrice(null, 2)).toBeNull();
    expect(midPrice(0, 2)).toBeNull();
    expect(midPrice(3, 2)).toBeNull();
  });

  it('rejects very wide markets for solving volatility', () => {
    expect(usableMid(8, 9.25)).toBe(8.625);
    expect(usableMid(0.2, 10)).toBeNull();
    expect(usableMid(0.01, 0.05)).toBeCloseTo(0.03, 12); // wide in ratio but only pennies apart
  });

  it('measures time to expiry', () => {
    const now = new Date('2026-11-24T21:00:00Z');
    expect(yearsTo('2026-11-25', now, 21)).toBeCloseTo(1 / 365, 12);
    expect(yearsTo('2026-11-24', now, 21)).toBe(0);
    expect(daysTo('2026-12-18', now)).toBe(24);
  });

  it('routes coin symbols', () => {
    expect(cryptoCurrency('btc')).toBe('BTC');
    expect(cryptoCurrency('ETH-USD')).toBe('ETH');
    expect(cryptoCurrency('XBTUSD')).toBe('BTC');
    expect(cryptoCurrency('AAPL')).toBeNull();
    expect(cryptoCurrency('ETHE')).toBeNull();
  });
});

describe('expiry selection', () => {
  const eq = { multiplier: 100, expiries: ['2026-11-25', '2026-11-27', '2026-12-18', '2027-01-15', '2027-06-17'] };

  it('recognises monthly expiries', () => {
    expect(isThirdFriday('2026-12-18')).toBe(true);
    expect(isThirdFriday('2026-11-27')).toBe(false);
    expect(isThirdFriday('2027-06-17')).toBe(true); // Thursday before a Friday holiday
    expect(monthlyExpiries(eq)).toEqual(['2026-12-18', '2027-01-15', '2027-06-17']);
    // The Thursday does not count when the Friday itself is listed.
    expect(monthlyExpiries({ multiplier: 100, expiries: ['2027-06-17', '2027-06-18'] })).toEqual(['2027-06-18']);
    expect(isLastFriday('2026-11-27')).toBe(true);
    expect(isLastFriday('2026-12-18')).toBe(false);
    expect(monthlyExpiries({ multiplier: 1, expiries: ['2026-11-27', '2026-12-04', '2026-12-25'] })).toEqual(['2026-11-27', '2026-12-25']);
  });

  it('defaults to the nearest monthly at least two days out', () => {
    const now = new Date('2026-11-24T14:00:00Z');
    expect(pickExpiry(eq, 'nearest', now)).toBe('2026-12-18');
    expect(pickExpiry(eq, undefined, now)).toBe('2026-12-18');
    expect(pickExpiry(eq, '2026-11-27', now)).toBe('2026-11-27');
    expect(pickExpiry(eq, '2027-01-20', now)).toBe('2027-01-15'); // closest listed date
    expect(pickExpiry(eq, 'nearest', new Date('2026-12-17T14:00:00Z'))).toBe('2027-01-15');
    expect(() => pickExpiry({ multiplier: 100, expiries: [] }, 'nearest', now)).toThrow();
  });
});

describe('enrichChain', () => {
  const now = new Date('2026-11-24T21:00:00Z');
  const expiry = '2027-02-22'; // 90 days out
  const T = 90 / 365;
  const rate = 0.04;
  const spot = 100;
  const sigma = 0.3;
  const quote = (type: 'C' | 'P', strike: number, price: number, oi = 10): RawQuote => ({ expiry, strike, type, bid: price - 0.01, ask: price + 0.01, last: price, volume: 1, oi });
  const base: Omit<RawChain, 'quotes'> = { symbol: 'TEST', spot, source: 'Test', multiplier: 100, currency: 'USD', model: 'bs', periods: 252, expiryHourUtc: 21, notes: [] };

  it('recovers the volatility and spot greeks of a no-dividend chain', () => {
    const quotes = [90, 100, 110].flatMap((K) => [
      quote('C', K, bsPrice({ type: 'C', S: spot, K, T, r: rate, sigma })),
      quote('P', K, bsPrice({ type: 'P', S: spot, K, T, r: rate, sigma })),
    ]);
    const chain = enrichChain({ ...base, quotes }, rate, 'test', now);
    expect(chain.expiries).toEqual([expiry]);
    expect(chain.forwards[expiry]).toBeCloseTo(spot * Math.exp(rate * T), 6);
    for (const q of chain.quotes) expect(q.iv).toBeCloseTo(sigma, 3);
    const atmCall = chain.quotes.find((q) => q.type === 'C' && q.strike === 100)!;
    expect(atmCall.delta).toBeCloseTo(0.5559, 3); // Black-Scholes spot delta N(d1), d1 = (r + sigma^2 / 2) T / (sigma sqrt T) = 0.1407
    expect(atmStrike(chain, expiry)).toBe(100);
    expect(atmIv(chain, expiry)).toBeCloseTo(sigma, 3);
    expect(otmSmile(chain, expiry).map((p) => `${p.strike}${p.type}`)).toEqual(['90P', '100C', '110C']);
  });

  it('prices against the parity forward, so a dividend does not split call and put vols', () => {
    const F = 98.5; // forward below spot x e^(rT): a dividend before expiry
    const quotes = [100, 110].flatMap((K) => [
      quote('C', K, black76Price({ type: 'C', S: F, K, T, r: rate, sigma })),
      quote('P', K, black76Price({ type: 'P', S: F, K, T, r: rate, sigma })),
    ]);
    const raw = { ...base, quotes };
    expect(impliedForwards(raw, rate, now)[expiry]).toBeCloseTo(F, 6);
    const chain = enrichChain(raw, rate, 'test', now);
    for (const q of chain.quotes) expect(q.iv).toBeCloseTo(sigma, 3);
  });

  it('falls back to the venue vol without a two-sided quote, and drops expired contracts', () => {
    const quotes: RawQuote[] = [
      { expiry, strike: 100, type: 'C', bid: null, ask: null, last: 5, volume: 0, oi: 3, ivGiven: 0.4 },
      { expiry, strike: 105, type: 'C', bid: null, ask: 1, last: null, volume: 0, oi: 3 },
      { expiry: '2026-11-20', strike: 100, type: 'C', bid: 1, ask: 1.1, last: 1, volume: 0, oi: 3 },
    ];
    const chain = enrichChain({ ...base, quotes }, rate, 'test', now);
    expect(chain.quotes).toHaveLength(2);
    expect(chain.quotes[0].iv).toBe(0.4);
    expect(chain.quotes[0].gamma).toBeGreaterThan(0);
    expect(chain.quotes[1].iv).toBeNull();
    expect(chain.quotes[1].delta).toBeNull();
    expect(chain.forwards).toEqual({});
  });

  it('prefers the venue vol and per-quote forward when told to', () => {
    const quotes: RawQuote[] = [{ expiry, strike: 60000, type: 'C', bid: 2000, ask: 2100, last: 2050, volume: 1, oi: 5, ivGiven: 0.5, underlying: 60500 }];
    const chain = enrichChain({ ...base, model: 'black76', preferGivenIv: true, spot: 60000, multiplier: 1, quotes }, 0, 'none', now);
    expect(chain.quotes[0].iv).toBe(0.5);
    expect(chain.quotes[0].delta).toBeGreaterThan(0.5);
    expect(chain.forwards).toEqual({});
  });
});
