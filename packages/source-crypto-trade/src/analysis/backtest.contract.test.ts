import { describe, expect, it } from 'vitest';
import type { Candle } from './candles.js';
import { runBacktest } from './backtest.js';

function candle(time: number, open: number, high: number, low: number, close: number, volume: number): Candle {
  return { time, open, high, low, close, volume };
}

function flatCandles(length: number): Candle[] {
  return Array.from({ length }, (_, index) => candle(index * 300_000, 100, 100.4, 99.8, 100.1, 1200));
}

describe('backtest contract', () => {
  it('runs a deterministic backtest and returns analytics buckets', () => {
    const candles = flatCandles(120).map((bar, index) => {
      if (index >= 80 && index < 90) {
        return { ...bar, close: 100 + (index - 79) * 0.6, high: 100 + (index - 79) * 0.7, volume: 2500 };
      }
      if (index >= 90) {
        return { ...bar, close: 106, high: 107, low: 105.5, volume: 2200 };
      }
      return bar;
    });

    let emitted = false;
    const result = runBacktest({
      symbol: 'BTC-USD',
      exchange: 'kraken',
      candles,
      signalEngine: (input) => {
        const latest = input.entryCandles.at(-1)!;
        if (!emitted && latest.time >= candles[85]!.time) {
          emitted = true;
          return {
            symbol: input.symbol,
            exchange: input.exchange,
            timestamp: latest.time,
            timeframe: '5m',
            regime: 'uptrend',
            setupType: 'long_trend_continuation',
            score: 84,
            direction: 'long',
            entryBias: 'market_or_limit',
            entryZone: { min: latest.close - 0.5, max: latest.close + 0.5 },
            stopLoss: latest.close - 1,
            takeProfit: latest.close + 2,
            riskReward: 2,
            indicators: {
              emaFast: 1, emaSlow: 1, emaTrend: 1, rsi: 45, macdLine: 1, macdSignal: 1, macdHistogram: 1, vwap: 1, atr: 1, atrPct: 0.4, volumeRatio: 1.4, spreadPct: 0.05,
            },
            reasons: ['Higher timeframe bullish bias'],
            rejectReasons: [],
            rejected: false,
            confidence: 0.84,
          };
        }
        return {
          symbol: input.symbol,
          exchange: input.exchange,
          timestamp: latest.time,
          timeframe: '5m',
          regime: 'sideways',
          setupType: null,
          score: 0,
          direction: null,
          entryBias: null,
          entryZone: null,
          stopLoss: null,
          takeProfit: null,
          riskReward: null,
          indicators: {
            emaFast: 0, emaSlow: 0, emaTrend: 0, rsi: 50, macdLine: 0, macdSignal: 0, macdHistogram: 0, vwap: 0, atr: 0, atrPct: 0.1, volumeRatio: 0.8, spreadPct: 0.05,
          },
          reasons: [],
          rejectReasons: ['no valid setup'],
          rejected: true,
          confidence: 0,
        };
      },
    });

    expect(result.trades).toHaveLength(1);
    expect(result.metrics.performanceBySymbol['BTC-USD']?.trades).toBe(1);
    expect(result.metrics.performanceByRegime.uptrend?.trades).toBe(1);
    expect(result.metrics.performanceByHourOfDay[String(new Date(result.trades[0]!.entryTime).getUTCHours())]?.trades).toBe(1);
    expect(result.metrics.performanceByVolatilityBucket.medium?.trades).toBe(1);
  });
});
