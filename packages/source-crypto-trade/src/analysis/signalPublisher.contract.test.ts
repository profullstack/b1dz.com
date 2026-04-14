import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '@b1dz/core';
import {
  publishEntrySignal,
  publishExitSignal,
  publishLiquidationSignal,
} from './signalPublisher.js';

function snap(): MarketSnapshot {
  return {
    exchange: 'kraken',
    pair: 'BTC-USD',
    bid: 100,
    ask: 100.1,
    bidSize: 2,
    askSize: 2,
    ts: 1234567890,
  };
}

describe('signal publisher contract', () => {
  it('publishes a structured entry opportunity with analysis metadata', () => {
    const opportunity = publishEntrySignal({
      strategyId: 'composite',
      exchange: 'kraken',
      pair: 'BTC-USD',
      snap: snap(),
      signal: { side: 'buy', strength: 0.84, reason: 'long_trend_continuation score=84' },
      projectedReturn: 103,
      projectedProfit: 2.1,
      analysis: {
        symbol: 'BTC-USD',
        exchange: 'kraken',
        timestamp: 123,
        timeframe: '5m',
        regime: 'uptrend',
        setupType: 'long_trend_continuation',
        score: 84,
        direction: 'long',
        entryBias: 'market_or_limit',
        entryZone: { min: 99.5, max: 100.5 },
        stopLoss: 98,
        takeProfit: 103,
        riskReward: 2,
        indicators: { emaFast: 1, emaSlow: 1, emaTrend: 1, rsi: 40, macdLine: 1, macdSignal: 1, macdHistogram: 1, vwap: 1, atr: 1, atrPct: 1, volumeRatio: 1.3, spreadPct: 0.05 },
        reasons: ['Higher timeframe bullish bias'],
        rejectReasons: [],
        rejected: false,
        confidence: 0.84,
      },
    });

    expect(opportunity.category).toBe('crypto-trade');
    expect(opportunity.title).toMatch(/^BUY BTC-USD/);
    expect(opportunity.confidence).toBe(0.84);
    expect(opportunity.metadata.analysis).toBeTruthy();
    expect(opportunity.metadata.signal).toMatchObject({ side: 'buy' });
  });

  it('publishes an exit opportunity with attached position metadata', () => {
    const opportunity = publishExitSignal({
      strategyId: 'composite',
      exchange: 'kraken',
      pair: 'BTC-USD',
      snap: snap(),
      signal: { side: 'sell', strength: 1, reason: 'trailing stop' },
      position: { pair: 'BTC-USD', exchange: 'kraken', entryPrice: 95, volume: 1.5, entryTime: 1, strategyId: 'composite' },
      projectedReturn: 150,
      projectedProfit: 6,
      titleReason: 'trailing stop at $98.00',
    });

    expect(opportunity.title).toContain('SELL BTC-USD');
    expect(opportunity.projectedReturn).toBe(150);
    expect(opportunity.metadata.position).toMatchObject({ entryPrice: 95, volume: 1.5 });
  });

  it('publishes a liquidation opportunity with liquidation metadata', () => {
    const opportunity = publishLiquidationSignal({
      strategyId: 'composite',
      exchange: 'kraken',
      pair: 'BTC-USD',
      snap: snap(),
      signal: { side: 'sell', strength: 1, reason: 'liquidate untracked holding' },
      liquidation: { exchange: 'kraken', pair: 'BTC-USD', volume: 0.2, discoveredAt: 1 },
    });

    expect(opportunity.title).toContain('liquidate untracked holding');
    expect(opportunity.projectedReturn).toBeCloseTo(20);
    expect(opportunity.metadata.liquidation).toMatchObject({ volume: 0.2 });
  });
});
