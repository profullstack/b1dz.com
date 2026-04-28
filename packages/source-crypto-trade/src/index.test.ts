import { afterEach, describe, it, expect } from 'vitest';
import {
  __reconstructEntryFromFillsForTests,
  __resetTradeStateForTests,
  getTradeStatus,
  momentumStrategy,
  restorePersistedTradeState,
  serializeTradeState,
} from './index.js';
import type { MarketSnapshot } from '@b1dz/core';

const snap = (bid: number, ts = 0): MarketSnapshot => ({
  exchange: 'gemini', pair: 'BTC-USD', bid, ask: bid + 0.5, bidSize: 1, askSize: 1, ts,
});

afterEach(() => {
  __resetTradeStateForTests();
});

describe('momentumStrategy', () => {
  it('emits a buy signal on 3 rising ticks', () => {
    const sig = momentumStrategy.evaluate(snap(105), [snap(100), snap(102), snap(105)]);
    expect(sig).not.toBeNull();
    expect(sig?.side).toBe('buy');
  });

  it('returns null when not strictly rising', () => {
    expect(momentumStrategy.evaluate(snap(100), [snap(100), snap(102), snap(101)])).toBeNull();
  });

  it('returns null when history is too short', () => {
    expect(momentumStrategy.evaluate(snap(100), [snap(100)])).toBeNull();
  });
});

describe('reconstructEntryFromFills', () => {
  it('uses weighted cost of the currently held lots instead of only the latest buy', () => {
    const entry = __reconstructEntryFromFillsForTests(
      { amount: 3 },
      [
        { side: 'buy', pair: 'ETH-USD', price: 120, volume: 1, time: 3 },
        { side: 'buy', pair: 'ETH-USD', price: 100, volume: 2, time: 2 },
      ],
    );

    expect(entry?.matchedVolume).toBe(3);
    expect(entry?.entryPrice).toBeCloseTo((120 + 200) / 3);
    expect(entry?.entryTime).toBe(2);
  });

  it('returns null when no usable purchase price is available', () => {
    expect(__reconstructEntryFromFillsForTests(
      { amount: 1 },
      [{ side: 'sell', pair: 'ETH-USD', price: 100, volume: 1, time: 1 }],
    )).toBeNull();
  });
});

describe('daily fee status', () => {
  it('publishes persisted daily fees to the TUI status snapshot', () => {
    const today = new Date().toDateString();
    restorePersistedTradeState({
      tradeState: {
        dailyPnlDate: today,
        dailyFees: 2.34,
        closedTrades: [{
          exchange: 'kraken',
          pair: 'BTC-USD',
          strategyId: 'test',
          entryPrice: 100,
          exitPrice: 101,
          volume: 1,
          entryTime: Date.now() - 60_000,
          exitTime: Date.now(),
          grossPnl: 1,
          fee: 0.26,
          netPnl: 0.74,
        }],
      },
    });

    expect(getTradeStatus().dailyFees).toBeCloseTo(2.34);
    expect(serializeTradeState().dailyFees).toBeCloseTo(2.34);
  });

  it('falls back to today closed-trade fees for older persisted payloads', () => {
    restorePersistedTradeState({
      tradeState: {
        dailyPnlDate: new Date().toDateString(),
        closedTrades: [{
          exchange: 'coinbase',
          pair: 'ETH-USD',
          strategyId: 'test',
          entryPrice: 100,
          exitPrice: 102,
          volume: 2,
          entryTime: Date.now() - 60_000,
          exitTime: Date.now(),
          grossPnl: 4,
          fee: 1.23,
          netPnl: 2.77,
        }],
      },
    });

    expect(getTradeStatus().dailyFees).toBeCloseTo(1.23);
  });
});
