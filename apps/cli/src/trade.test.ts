import { describe, expect, it } from 'vitest';
import { accountLines, parseTicketLine, parseTradeArgs, tradeError } from './trade.js';
import { WEB_TERMINAL, webLink } from './research/tui.js';

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

describe('TUI ticket line', () => {
  it('reads shares, dollars and a limit', () => {
    expect(parseTicketLine('buy', 'NVDA', '5')).toEqual({ ok: true, order: { symbol: 'NVDA', side: 'buy', type: 'market', tif: 'day', qty: 5 } });
    expect(parseTicketLine('buy', 'SPY', '$1,500')).toEqual({ ok: true, order: { symbol: 'SPY', side: 'buy', type: 'market', tif: 'day', notionalUsd: 1500 } });
    expect(parseTicketLine('sell', 'AAPL', '2 @190.50 gtc ext')).toEqual({
      ok: true,
      order: { symbol: 'AAPL', side: 'sell', type: 'limit', tif: 'gtc', qty: 2, limitPrice: 190.5, extendedHours: true },
    });
  });

  it('rejects an empty or unusable line', () => {
    expect(parseTicketLine('buy', 'NVDA', '').ok).toBe(false);
    expect(parseTicketLine('buy', 'NVDA', 'lots').ok).toBe(false);
    expect(parseTicketLine('buy', 'NVDA', '5 ext').ok).toBe(false); // extended hours need a limit
    expect(parseTicketLine('buy', 'BTC-USD', '1').ok).toBe(false);
  });
});

describe('account text', () => {
  it('lists the broker, buying power, positions and open orders only', () => {
    const lines = accountLines({
      brokers: [{ id: 'alpaca', paper: true }, { id: 'moomoo', paper: false }],
      broker: 'alpaca',
      label: 'Alpaca',
      paper: true,
      session: 'open',
      buyingPowerUsd: 48250.75,
      positions: [{ symbol: 'AAPL', qty: 10, avgEntry: 180, marketValue: 3490.8 }],
      ordersSupported: true,
      orders: [
        { orderId: 'o1', symbol: 'NVDA', side: 'buy', type: 'limit', limitPrice: 150, qty: 2, status: 'accepted', open: true },
        { orderId: 'o2', symbol: 'MSFT', side: 'sell', type: 'market', qty: 1, status: 'filled', open: false },
      ],
    }).join('\n');
    expect(lines).toContain('Alpaca  PAPER  market open');
    expect(lines).toContain('Buying power  $48,250.75');
    expect(lines).toContain('alpaca (paper), moomoo');
    expect(lines).toMatch(/AAPL\s+10\s+avg 180\s+\$3,490\.80/);
    expect(lines).toContain('o1');
    expect(lines).not.toContain('o2');
  });

  it('says what to do with no broker, a broken link, or a locked session', () => {
    expect(accountLines({ brokers: [] })[0]).toMatch(/No broker linked/);
    expect(accountLines({ brokers: [{ id: 'moomoo' }], label: 'moomoo', error: 'reconnect moomoo in Settings' })).toEqual(['moomoo: reconnect moomoo in Settings']);
    expect(tradeError({ ok: false, status: 423, body: { error: 'Trading is locked.' } })).toMatch(/b1dz unlock/);
    expect(tradeError({ ok: false, status: 422, body: { error: 'insufficient buying power' } })).toBe('insufficient buying power');
  });
});

describe('web link', () => {
  it('opens the web terminal on the same view', () => {
    expect(webLink('company', 'overview', { symbol: 'NVDA', range: '1Y' })).toBe(`${WEB_TERMINAL}?d=company&t=overview&symbol=NVDA&range=1Y`);
    expect(webLink(undefined, undefined, {})).toBe('https://b1dz.com/terminal');
    expect(webLink('my', 'cards', {})).toBe('https://b1dz.com/terminal');
  });
});
