import { describe, it, expect } from 'vitest';
import type { Signal, MarketSession } from '@b1dz/core';
import { decideEquityOrder, DEFAULT_EQUITY_RISK, type DecisionInput, type EquityRiskConfig } from './index.js';

const OPEN: MarketSession = { status: 'open', timezone: 'America/New_York' };
const buy: Signal = { side: 'buy', strength: 0.8, reason: 'trend up' };
const sell: Signal = { side: 'sell', strength: 0.8, reason: 'trend down' };

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    signal: buy,
    symbol: 'AAPL',
    session: OPEN,
    haltState: 'none',
    lastPrice: 100,
    account: { buyingPowerUsd: 10_000, equityUsd: 100_000 },
    position: { qty: 0 },
    config: { ...DEFAULT_EQUITY_RISK },
    supportsFractional: true,
    ...over,
  };
}

describe('tradeability gates', () => {
  it('skips when the market is closed', () => {
    const d = decideEquityOrder(input({ session: { status: 'closed', timezone: 'America/New_York' } }));
    expect(d.action).toBe('skip');
    expect(d).toMatchObject({ reason: expect.stringContaining('closed') });
  });

  it('allows pre/post only when extended hours is enabled', () => {
    const pre: MarketSession = { status: 'pre', timezone: 'America/New_York' };
    expect(decideEquityOrder(input({ session: pre })).action).toBe('skip');
    const cfg: EquityRiskConfig = { ...DEFAULT_EQUITY_RISK, extendedHours: true };
    const d = decideEquityOrder(input({ session: pre, config: cfg }));
    expect(d.action).toBe('place');
    if (d.action === 'place') expect(d.order.extendedHours).toBe(true);
  });

  it('skips halted / LULD symbols', () => {
    expect(decideEquityOrder(input({ haltState: 'halted' })).action).toBe('skip');
    expect(decideEquityOrder(input({ haltState: 'luld' })).action).toBe('skip');
  });

  it('skips when price is unusable', () => {
    expect(decideEquityOrder(input({ lastPrice: 0 })).action).toBe('skip');
  });
});

describe('signal strength', () => {
  it('skips signals below the threshold', () => {
    const d = decideEquityOrder(input({ signal: { side: 'buy', strength: 0.05, reason: 'weak' } }));
    expect(d).toMatchObject({ action: 'skip', reason: expect.stringContaining('weak') });
  });
});

describe('entry sizing', () => {
  it('uses notional-first when fractional is supported', () => {
    const d = decideEquityOrder(input());
    expect(d.action).toBe('place');
    if (d.action === 'place') {
      expect(d.order).toMatchObject({ side: 'buy', notionalUsd: 500, type: 'market' });
      expect(d.order.qty).toBeUndefined();
    }
  });

  it('falls back to whole shares without fractional', () => {
    const d = decideEquityOrder(input({ supportsFractional: false, lastPrice: 150 }));
    if (d.action === 'place') expect(d.order.qty).toBe(3); // floor(500/150)
    else throw new Error('expected place');
  });

  it('skips when whole-share size rounds below 1', () => {
    const cfg = { ...DEFAULT_EQUITY_RISK, perTradeUsd: 50 };
    const d = decideEquityOrder(input({ supportsFractional: false, lastPrice: 100, config: cfg }));
    expect(d).toMatchObject({ action: 'skip', reason: expect.stringContaining('1 share') });
  });

  it('never sizes past buying power', () => {
    const d = decideEquityOrder(input({ account: { buyingPowerUsd: 120, equityUsd: 100_000 }, supportsFractional: true }));
    if (d.action === 'place') expect(d.order.notionalUsd).toBe(120);
    else throw new Error('expected place');
  });

  it('respects the per-symbol position cap', () => {
    // Already holding $1900 of a $2000-cap symbol → only $100 headroom.
    const d = decideEquityOrder(input({ position: { qty: 19 }, lastPrice: 100 }));
    if (d.action === 'place') expect(d.order.notionalUsd).toBe(100);
    else throw new Error('expected place');
  });

  it('skips when the position is already at cap', () => {
    const d = decideEquityOrder(input({ position: { qty: 20 }, lastPrice: 100 }));
    expect(d).toMatchObject({ action: 'skip', reason: expect.stringContaining('cap') });
  });
});

describe('overnight gating', () => {
  it('blocks new entries near the close when overnight is disallowed', () => {
    const session: MarketSession = { status: 'open', timezone: 'America/New_York', nextClose: new Date(Date.now() + 5 * 60_000).toISOString() };
    const d = decideEquityOrder(input({ session }));
    expect(d).toMatchObject({ action: 'skip', reason: expect.stringContaining('overnight') });
  });

  it('caps size to the remaining overnight budget when overnight is allowed', () => {
    const cfg: EquityRiskConfig = { ...DEFAULT_EQUITY_RISK, allowOvernight: true, maxOvernightUsd: 1000 };
    const d = decideEquityOrder(input({ config: cfg, openOvernightExposureUsd: 800 }));
    if (d.action === 'place') expect(d.order.notionalUsd).toBe(200);
    else throw new Error('expected place');
  });
});

describe('exit (sell)', () => {
  it('exits the full position on a sell signal', () => {
    const d = decideEquityOrder(input({ signal: sell, position: { qty: 7 } }));
    expect(d).toMatchObject({ action: 'place', order: { side: 'sell', qty: 7, type: 'market' } });
  });

  it('skips a sell with no position (no shorting)', () => {
    const d = decideEquityOrder(input({ signal: sell, position: { qty: 0 } }));
    expect(d).toMatchObject({ action: 'skip', reason: expect.stringContaining('no position') });
  });
});

describe('PDT guard', () => {
  const restricted = { buyingPowerUsd: 10_000, equityUsd: 20_000, recentDayTrades: 3 };

  it('blocks closing a same-day position as the 4th day trade', () => {
    const d = decideEquityOrder(input({ signal: sell, position: { qty: 5, openedToday: true }, account: restricted }));
    expect(d).toMatchObject({ action: 'skip', reason: expect.stringContaining('PDT') });
  });

  it('allows the exit if the position was not opened today (not a day trade)', () => {
    const d = decideEquityOrder(input({ signal: sell, position: { qty: 5, openedToday: false }, account: restricted }));
    expect(d.action).toBe('place');
  });

  it('does not restrict accounts at/above $25k', () => {
    const d = decideEquityOrder(input({ signal: sell, position: { qty: 5, openedToday: true }, account: { buyingPowerUsd: 10_000, equityUsd: 25_000, recentDayTrades: 9 } }));
    expect(d.action).toBe('place');
  });
});
