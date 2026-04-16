import { afterEach, describe, expect, it } from 'vitest';
import {
  __getAnalysisStateForTests,
  __pruneInactivePairStateForTests,
  __resetTradeStateForTests,
  __seedAnalysisStateForTests,
  restoreAnalysisCache,
  restorePersistedTradeState,
  serializeAnalysisCache,
  serializeTradeState,
} from './index.js';

describe('analysis state persistence contract', () => {
  afterEach(() => {
    __resetTradeStateForTests();
  });

  it('round-trips persisted analysis candles and last analysis across restart restore', () => {
    __seedAnalysisStateForTests('kraken', 'BTC-USD', {
      entryCandles: [
        { time: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
        { time: 2, open: 100.5, high: 102, low: 100, close: 101.5, volume: 12 },
      ],
      confirmCandles: [
        { time: 1, open: 100, high: 103, low: 99, close: 102, volume: 20 },
      ],
      biasCandles: [
        { time: 1, open: 98, high: 104, low: 97, close: 103, volume: 30 },
      ],
      lastAnalysis: {
        symbol: 'BTC-USD',
        exchange: 'kraken',
        timestamp: 123,
        timeframe: '5m',
        regime: 'uptrend',
        setupType: 'long_trend_continuation',
        score: 84,
        direction: 'long',
        entryBias: 'market_or_limit',
        entryZone: { min: 100, max: 101 },
        stopLoss: 98,
        takeProfit: 104,
        riskReward: 2,
        indicators: {
          emaFast: 100,
          emaSlow: 99,
          emaTrend: 97,
          rsi: 44,
          macdLine: 1.2,
          macdSignal: 1.0,
          macdHistogram: 0.2,
          vwap: 100.2,
          atr: 1.4,
          atrPct: 1.3,
          volumeRatio: 1.4,
          spreadPct: 0.04,
        },
        reasons: ['Higher timeframe bullish bias'],
        rejectReasons: [],
        rejected: false,
        confidence: 0.84,
      },
    });

    const serialized = serializeTradeState();
    const analysisCache = serializeAnalysisCache();
    __resetTradeStateForTests();
    restorePersistedTradeState({ tradeState: serialized });
    restoreAnalysisCache(analysisCache);

    const restored = __getAnalysisStateForTests('kraken', 'BTC-USD');
    expect(restored).not.toBeNull();
    expect(restored?.entryCandles).toHaveLength(2);
    expect(restored?.confirmCandles).toHaveLength(1);
    expect(restored?.biasCandles).toHaveLength(1);
    expect(restored?.lastAnalysis).toMatchObject({
      symbol: 'BTC-USD',
      regime: 'uptrend',
      score: 84,
      direction: 'long',
    });
  });

  it('prunes inactive analysis state for pairs that are no longer eligible', () => {
    __seedAnalysisStateForTests('kraken', 'BTC-USD', {
      entryCandles: [{ time: 1, open: 100, high: 101, low: 99, close: 100, volume: 1 }],
      confirmCandles: [],
      biasCandles: [],
      lastAnalysis: null,
    });
    __seedAnalysisStateForTests('coinbase', 'ETH-USD', {
      entryCandles: [{ time: 1, open: 200, high: 201, low: 199, close: 200, volume: 1 }],
      confirmCandles: [],
      biasCandles: [],
      lastAnalysis: null,
    });

    __pruneInactivePairStateForTests(['BTC-USD']);

    expect(__getAnalysisStateForTests('kraken', 'BTC-USD')).not.toBeNull();
    expect(__getAnalysisStateForTests('coinbase', 'ETH-USD')).toBeNull();
  });
});
