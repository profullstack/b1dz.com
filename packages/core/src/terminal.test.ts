import { describe, expect, it } from 'vitest';
import { describeOrder, editWatchlist, estimateOrderUsd, normalizeWatchSymbol, parseManualOrder, parseWatchlist, serializeWatchlist } from './terminal.js';

describe('watchlist', () => {
  it('normalizes the symbols research cards take', () => {
    expect(normalizeWatchSymbol(' aapl ')).toBe('AAPL');
    expect(normalizeWatchSymbol('brk.b')).toBe('BRK.B');
    expect(normalizeWatchSymbol('btc-usd')).toBe('BTC-USD');
    expect(normalizeWatchSymbol('^gspc')).toBe('^GSPC');
    expect(normalizeWatchSymbol('EURUSD=X')).toBe('EURUSD=X');
    expect(normalizeWatchSymbol('')).toBeNull();
    expect(normalizeWatchSymbol('<script>')).toBeNull();
    expect(normalizeWatchSymbol('A'.repeat(21))).toBeNull();
  });

  it('parses strings and arrays, drops junk and duplicates, caps the size', () => {
    expect(parseWatchlist('aapl, msft  AAPL ;;; tsla')).toEqual(['AAPL', 'MSFT', 'TSLA']);
    expect(parseWatchlist(['nvda', 7, null, 'NVDA', 'spy'])).toEqual(['NVDA', 'SPY']);
    expect(parseWatchlist(undefined)).toEqual([]);
    expect(parseWatchlist(Array.from({ length: 150 }, (_, i) => `S${i}`))).toHaveLength(100);
    expect(serializeWatchlist(['aapl', 'x y'])).toBe('AAPL');
  });

  it('adds and removes without duplicating', () => {
    const list = ['AAPL'];
    expect(editWatchlist(list, 'add', 'msft')).toEqual(['AAPL', 'MSFT']);
    expect(editWatchlist(list, 'add', 'aapl')).toBe(list);
    expect(editWatchlist(list, 'remove', 'aapl')).toEqual([]);
    expect(editWatchlist(list, 'remove', 'tsla')).toBe(list);
    expect(editWatchlist(list, 'add', '!!')).toBe(list);
  });
});

describe('parseManualOrder', () => {
  it('accepts a market order by shares and by dollars', () => {
    expect(parseManualOrder({ symbol: 'aapl', side: 'buy', qty: '5' })).toEqual({ ok: true, order: { symbol: 'AAPL', side: 'buy', type: 'market', tif: 'day', qty: 5 } });
    expect(parseManualOrder({ symbol: 'SPY', side: 'sell', notionalUsd: 250.5, type: 'market', tif: 'day' })).toEqual({
      ok: true,
      order: { symbol: 'SPY', side: 'sell', type: 'market', tif: 'day', notionalUsd: 250.5 },
    });
  });

  it('accepts a limit order with extended hours', () => {
    expect(parseManualOrder({ symbol: 'BRK.B', side: 'buy', qty: 2, type: 'limit', limitPrice: '410.25', tif: 'gtc', extendedHours: true })).toEqual({
      ok: true,
      order: { symbol: 'BRK.B', side: 'buy', type: 'limit', tif: 'gtc', qty: 2, limitPrice: 410.25, extendedHours: true },
    });
  });

  it.each([
    [{ symbol: 'BTC-USD', side: 'buy', qty: 1 }, /ticker/],
    [{ symbol: '', side: 'buy', qty: 1 }, /ticker/],
    [{ symbol: 'AAPL', side: 'hold', qty: 1 }, /buy or sell/],
    [{ symbol: 'AAPL', side: 'buy' }, /either/],
    [{ symbol: 'AAPL', side: 'buy', qty: 1, notionalUsd: 100 }, /either/],
    [{ symbol: 'AAPL', side: 'buy', qty: -1 }, /positive/],
    [{ symbol: 'AAPL', side: 'buy', qty: 'abc' }, /positive/],
    [{ symbol: 'AAPL', side: 'buy', notionalUsd: 0.5 }, /at least \$1/],
    [{ symbol: 'AAPL', side: 'buy', qty: 1, type: 'stop' }, /market or limit/],
    [{ symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit' }, /limit price/],
    [{ symbol: 'AAPL', side: 'buy', notionalUsd: 100, type: 'limit', limitPrice: 10 }, /sized in shares/],
    [{ symbol: 'AAPL', side: 'buy', qty: 1, tif: 'fok' }, /time in force/],
    [{ symbol: 'AAPL', side: 'buy', qty: 1, extendedHours: true }, /extended hours/],
    [null, /ticker/],
  ])('rejects %j', (input, pattern) => {
    const r = parseManualOrder(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(pattern);
  });
});

describe('order helpers', () => {
  it('estimates dollars from notional, limit price or the quote', () => {
    expect(estimateOrderUsd({ symbol: 'A', side: 'buy', type: 'market', tif: 'day', notionalUsd: 300 }, 10)).toBe(300);
    expect(estimateOrderUsd({ symbol: 'A', side: 'buy', type: 'limit', tif: 'day', qty: 4, limitPrice: 25 }, 10)).toBe(100);
    expect(estimateOrderUsd({ symbol: 'A', side: 'buy', type: 'market', tif: 'day', qty: 4 }, 10)).toBe(40);
    expect(estimateOrderUsd({ symbol: 'A', side: 'buy', type: 'market', tif: 'day', qty: 4 }, 0)).toBe(0);
  });

  it('describes an order in plain words', () => {
    expect(describeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', tif: 'day', qty: 5 })).toBe('Buy 5 AAPL at market, DAY');
    expect(describeOrder({ symbol: 'AAPL', side: 'sell', type: 'limit', tif: 'gtc', qty: 2, limitPrice: 190.5, extendedHours: true })).toBe('Sell 2 AAPL limit $190.5, GTC, extended hours');
    expect(describeOrder({ symbol: 'SPY', side: 'buy', type: 'market', tif: 'day', notionalUsd: 1500 })).toBe('Buy $1,500 of SPY at market, DAY');
  });
});
