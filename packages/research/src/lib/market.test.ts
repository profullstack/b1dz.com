import { describe, expect, it } from 'vitest';
import { classify, closeOnOrBefore, computeReturns, fxPair, mapLimit, parseCboeCsv, parseCoinbaseCandles, parseFrankfurterSeries, parseKrakenOhlc, parseTmxHistory, rangeStart, tmxSymbol, type Bar } from './market.js';
import { nasdaqSymbol, parseHistoricalRows, parseNasdaqTime, parseTrade, usDateMs } from './nasdaq.js';
import { parseYahooChart } from './yahoo.js';

const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const bar = (iso: string, c: number): Bar => ({ t: day(iso), o: c, h: c, l: c, c, v: null });

describe('classify', () => {
  it('reads the symbol convention', () => {
    expect(classify('AAPL')).toBe('stock');
    expect(classify('BRK-B')).toBe('stock');
    expect(classify('RY.TO')).toBe('stock');
    expect(classify('^GSPC')).toBe('index');
    expect(classify('EURUSD=X')).toBe('fx');
    expect(classify('ES=F')).toBe('future');
    expect(classify('CLZ26.NYM')).toBe('future');
    expect(classify('btc-usd')).toBe('crypto');
  });
});

describe('rangeStart', () => {
  const now = new Date('2026-03-31T15:00:00Z');
  it('counts months back and clamps to the month end', () => {
    expect(rangeStart('1M', now).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(rangeStart('1Y', now).toISOString().slice(0, 10)).toBe('2025-03-31');
    expect(rangeStart('10Y', now).toISOString().slice(0, 10)).toBe('2016-03-31');
    expect(rangeStart('MAX', now).getTime()).toBe(0);
  });
});

describe('symbol mapping', () => {
  it('maps currency pairs', () => {
    expect(fxPair('EURUSD=X')).toEqual({ base: 'EUR', quote: 'USD' });
    expect(fxPair('JPY=X')).toEqual({ base: 'USD', quote: 'JPY' });
    expect(fxPair('NOPE')).toBeNull();
  });
  it('maps Canadian listings and indices to TMX symbols', () => {
    expect(tmxSymbol('RY.TO')).toBe('RY');
    expect(tmxSymbol('BBD-B.TO')).toBe('BBD.B');
    expect(tmxSymbol('^GSPTSE')).toBe('^TSX');
    expect(tmxSymbol('AAPL')).toBeNull();
    expect(tmxSymbol('SHEL.L')).toBeNull();
  });
  it('uses a dot for share classes at Nasdaq', () => {
    expect(nasdaqSymbol('brk-b')).toBe('BRK.B');
  });
});

describe('provider parsers', () => {
  it('parses Cboe index files, with and without OHLC, and applies a scale', () => {
    expect(parseCboeCsv('DATE,SPX\n01/02/1975,70.230000\n01/03/1975,70.710000\n')).toEqual([bar('1975-01-02', 70.23), bar('1975-01-03', 70.71)]);
    const vix = parseCboeCsv('DATE,OPEN,HIGH,LOW,CLOSE\n11/23/2026,31.38,35.08,15.39,26.62\n');
    expect(vix[0]).toEqual({ t: day('2026-11-23'), o: 31.38, h: 35.08, l: 15.39, c: 26.62, v: null });
    expect(parseCboeCsv('DATE,DJX\n11/23/2026,495.95\n', 100)[0].c).toBeCloseTo(49595);
  });
  it('parses Nasdaq historical rows oldest first', () => {
    const bars = parseHistoricalRows([
      { date: '11/23/2026', close: '$349.08', volume: '58,588,700', open: '$347.87', high: '$352.60', low: '$345.4422' },
      { date: '11/20/2026', close: '26,746.10', volume: '--', open: '26,889.29', high: '27,018.88', low: '26,386.42' },
    ]);
    expect(bars.map((b) => b.t)).toEqual([day('2026-11-20'), day('2026-11-23')]);
    expect(bars[1]).toMatchObject({ c: 349.08, o: 347.87, v: 58588700 });
    expect(bars[0]).toMatchObject({ c: 26746.1, v: null });
    expect(Number.isNaN(usDateMs('2026-11-23'))).toBe(true);
  });
  it('parses a Nasdaq trade block and its timestamp', () => {
    expect(parseTrade({ lastSalePrice: '$347.38', netChange: '-1.70', percentageChange: '-0.49%', lastTradeTimestamp: 'Nov 24, 2026 8:41 AM ET' })).toEqual({ price: 347.38, change: -1.7, changePct: -0.49, prevClose: 349.08, time: '2026-11-24T08:41:00 ET' });
    expect(parseNasdaqTime('Closed at Nov 23, 2026 4:00 PM ET')).toBe('2026-11-23T16:00:00 ET');
    expect(parseNasdaqTime('Nov 3, 2026')).toBe('2026-11-03');
    expect(parseTrade({ lastSalePrice: '$56.21', netChange: '', percentageChange: '' }).change).toBeNull();
  });
  it('parses Coinbase candles (time, low, high, open, close, volume)', () => {
    const bars = parseCoinbaseCandles([[1795478400, 59300.01, 61603.49, 61190.81, 60093.05, 5834.03], [1795392000, 60286.92, 64533.96, 61163.01, 61189.97, 16914.31]]);
    expect(bars).toHaveLength(2);
    expect(bars[1]).toEqual({ t: 1795478400000, o: 61190.81, h: 61603.49, l: 59300.01, c: 60093.05, v: 5834.03 });
    expect(parseCoinbaseCandles({ message: 'NotFound' })).toEqual([]);
  });
  it('parses Kraken OHLC and surfaces its errors', () => {
    const bars = parseKrakenOhlc({ error: [], result: { XXBTZUSD: [[1733270400, '95917.5', '99213.9', '94656.9', '98757.1', '97143.5', '4007.4', 61942]], last: 1733270400 } });
    expect(bars).toEqual([{ t: 1733270400000, o: 95917.5, h: 99213.9, l: 94656.9, c: 98757.1, v: 4007.4 }]);
    expect(() => parseKrakenOhlc({ error: ['EQuery:Unknown asset pair'] })).toThrow(/Unknown asset pair/);
  });
  it('parses a Frankfurter time series', () => {
    const bars = parseFrankfurterSeries({ base: 'EUR', rates: { '2026-11-23': { USD: 1.0939 }, '2026-11-20': { USD: 1.099 } } }, 'USD');
    expect(bars.map((b) => b.c)).toEqual([1.099, 1.0939]);
  });
  it('parses TMX price history', () => {
    const bars = parseTmxHistory([{ datetime: '2026-11-23', openPrice: 269.43, closePrice: 270.29, high: 272.67, low: 267.45, volume: 4845643 }, { datetime: '2026-11-20', closePrice: null }]);
    expect(bars).toEqual([{ t: day('2026-11-23'), o: 269.43, h: 272.67, l: 267.45, c: 270.29, v: 4845643 }]);
  });
});

describe('Yahoo chart parser (fixture in the documented v8 shape)', () => {
  const fixture = {
    chart: {
      result: [
        {
          meta: { currency: 'USD', symbol: 'CL=F', exchangeName: 'NYM', fullExchangeName: 'NY Mercantile', shortName: 'Crude Oil Jan 27', regularMarketPrice: 61.5, regularMarketTime: 1795530000, chartPreviousClose: 59.9 },
          timestamp: [1795219200, 1795305600, 1795392000, 1795478400],
          indicators: { quote: [{ open: [60, 60.4, null, 61.1], high: [60.9, 61, null, 61.8], low: [59.5, 60, null, 60.7], close: [60.2, 60.8, null, 61.5], volume: [1000, 1200, null, 800] }] },
        },
      ],
      error: null,
    },
  };
  it('drops empty bars and derives the previous close from the bar before the last trade day', () => {
    const p = parseYahooChart(fixture);
    expect(p.bars).toHaveLength(3);
    expect(p.bars[0]).toEqual({ t: 1795219200000, o: 60, h: 60.9, l: 59.5, c: 60.2, v: 1000 });
    expect(p.price).toBe(61.5);
    expect(p.prevClose).toBe(60.8);
    expect(p.currency).toBe('USD');
    expect(p.name).toBe('Crude Oil Jan 27');
    expect(p.exchange).toBe('NY Mercantile');
  });
  it('throws the provider message when there is no result', () => {
    expect(() => parseYahooChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } })).toThrow(/No data found/);
  });
});

describe('returns', () => {
  const bars: Bar[] = [bar('2025-11-21', 80), bar('2025-12-31', 100), bar('2026-08-21', 90), bar('2026-10-23', 110), bar('2026-11-16', 120), bar('2026-11-20', 125), bar('2026-11-23', 121)];
  it('finds the close on or before a date', () => {
    expect(closeOnOrBefore(bars, day('2026-11-22'))).toBe(125);
    expect(closeOnOrBefore(bars, day('2025-11-21'))).toBe(80);
    expect(closeOnOrBefore(bars, day('2025-01-01'))).toBeNull();
  });
  it('measures each horizon from the close on or before its start', () => {
    const r = computeReturns(bars);
    expect(r.last).toBe(121);
    expect(r.day).toBeCloseTo((121 / 125 - 1) * 100);
    expect(r.w1).toBeCloseTo((121 / 120 - 1) * 100);
    expect(r.m1).toBeCloseTo((121 / 110 - 1) * 100);
    expect(r.m3).toBeCloseTo((121 / 90 - 1) * 100);
    expect(r.ytd).toBeCloseTo(21);
    expect(r.y1).toBeCloseTo((121 / 80 - 1) * 100);
  });
  it('leaves a horizon empty when history is too short', () => {
    const r = computeReturns(bars.slice(4));
    expect(r.y1).toBeNull();
    expect(r.ytd).toBeNull();
    expect(computeReturns([]).last).toBeNull();
  });
});

describe('mapLimit', () => {
  it('keeps order and never exceeds the limit', async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, n));
      live--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 6, 4, 8]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
