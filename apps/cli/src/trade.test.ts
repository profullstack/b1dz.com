import { describe, expect, it } from 'vitest';
import { parseTradeArgs } from './trade.js';

describe('parseTradeArgs', () => {
  it('defaults to the account view', () => {
    expect(parseTradeArgs([]).command).toEqual({ kind: 'account' });
    expect(parseTradeArgs(['orders', '--json'])).toEqual({ command: { kind: 'orders' }, flags: { yes: false, json: true } });
    expect(parseTradeArgs(['help']).command.kind).toBe('help');
  });

  it('parses a market order by shares and by dollars', () => {
    expect(parseTradeArgs(['buy', 'aapl', '5']).command).toEqual({ kind: 'order', order: { symbol: 'AAPL', side: 'buy', type: 'market', tif: 'day', qty: 5 } });
    expect(parseTradeArgs(['buy', 'SPY', '$1,500', '--yes', '--broker', 'Alpaca'])).toEqual({
      command: { kind: 'order', order: { symbol: 'SPY', side: 'buy', type: 'market', tif: 'day', notionalUsd: 1500 } },
      flags: { yes: true, json: false, broker: 'alpaca' },
    });
  });

  it('parses a limit order with flags in any position', () => {
    expect(parseTradeArgs(['sell', '--limit', '190.50', 'AAPL', '2', '--gtc', '--ext']).command).toEqual({
      kind: 'order',
      order: { symbol: 'AAPL', side: 'sell', type: 'limit', tif: 'gtc', qty: 2, limitPrice: 190.5, extendedHours: true },
    });
  });

  it('reports what is wrong with a ticket', () => {
    expect(parseTradeArgs(['buy', 'AAPL']).command.kind).toBe('error');
    const bad = parseTradeArgs(['buy', 'BTC-USD', '1']).command;
    expect(bad.kind === 'error' && bad.message).toMatch(/ticker/);
    const ext = parseTradeArgs(['buy', 'AAPL', '1', '--ext']).command;
    expect(ext.kind === 'error' && ext.message).toMatch(/extended hours/);
    expect(parseTradeArgs(['hodl']).command.kind).toBe('error');
    expect(parseTradeArgs(['cancel']).command.kind).toBe('error');
  });

  it('parses cancel and watchlist edits', () => {
    expect(parseTradeArgs(['cancel', 'abc-123']).command).toEqual({ kind: 'cancel', orderId: 'abc-123' });
    expect(parseTradeArgs(['watch']).command).toEqual({ kind: 'watch', edits: [] });
    expect(parseTradeArgs(['watch', '+NVDA', 'msft', '-TSLA']).command).toEqual({
      kind: 'watch',
      edits: [{ action: 'add', symbol: 'NVDA' }, { action: 'add', symbol: 'msft' }, { action: 'remove', symbol: 'TSLA' }],
    });
  });
});
