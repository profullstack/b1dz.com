import { describe, expect, it } from 'vitest';
import { stripLiveSourceState } from './runtime-cache.js';

describe('stripLiveSourceState', () => {
  it('keeps the small status-bar fields when falling back to persisted source_state', () => {
    const payload = {
      enabled: true,
      daemon: {
        lastTickAt: '2026-04-28T10:00:00.000Z',
        worker: 'crypto-trade',
        status: 'running',
        version: '0.3.9',
      },
      tradeStatus: {
        dailyPnl: 12.34,
        dailyPnlPct: 1.23,
        dailyFees: 0.42,
        dailyLossLimitHit: false,
        positions: [
          {
            exchange: 'kraken',
            pair: 'BTC-USD',
            entryPrice: 100,
            currentPrice: 101,
            volume: 1,
            pnlUsd: 1,
            pnlPct: 1,
            stopPrice: 95,
            elapsed: '1m',
          },
        ],
      },
      // Heavy/noisy tick data should still be stripped from DB fallback.
      prices: [{ exchange: 'kraken', pair: 'BTC-USD', bid: 101, ask: 102 }],
      rawLog: [{ at: 'now', text: 'noise' }],
      tradeState: { closedTrades: [{ pair: 'BTC-USD' }] },
    };

    const stripped = stripLiveSourceState(payload) as Record<string, unknown>;

    expect(stripped.daemon).toEqual(payload.daemon);
    expect(stripped.tradeStatus).toEqual(payload.tradeStatus);
    expect(stripped.prices).toBeUndefined();
    expect(stripped.rawLog).toBeUndefined();
    expect(stripped.tradeState).toBeUndefined();
  });
});
