import { describe, expect, it } from 'vitest';
import { computeBacktestMetrics, type BacktestTrade } from './analytics.js';

const trades: BacktestTrade[] = [
  {
    symbol: 'BTC-USD',
    exchange: 'kraken',
    direction: 'long',
    regime: 'uptrend',
    setupType: 'long_trend_continuation',
    score: 84,
    entryTime: 0,
    exitTime: 60 * 60 * 1000,
    entryPrice: 100,
    exitPrice: 103,
    stopLoss: 98,
    takeProfit: 103,
    grossPnl: 3,
    fees: 0.2,
    slippageCost: 0.1,
    netPnl: 2.8,
    holdMinutes: 60,
    hourOfDay: 0,
    volatilityBucket: 'medium',
  },
  {
    symbol: 'ETH-USD',
    exchange: 'coinbase',
    direction: 'short',
    regime: 'downtrend',
    setupType: 'short_trend_continuation',
    score: 76,
    entryTime: 2 * 60 * 60 * 1000,
    exitTime: 3 * 60 * 60 * 1000,
    entryPrice: 200,
    exitPrice: 202,
    stopLoss: 204,
    takeProfit: 196,
    grossPnl: -2,
    fees: 0.3,
    slippageCost: 0.1,
    netPnl: -2.3,
    holdMinutes: 60,
    hourOfDay: 2,
    volatilityBucket: 'high',
  },
];

describe('analytics contract', () => {
  it('computes summary metrics and grouped performance buckets', () => {
    const metrics = computeBacktestMetrics(trades, 100);

    expect(metrics.totalReturn).toBeCloseTo(0.5);
    expect(metrics.winRate).toBe(50);
    expect(metrics.profitFactor).toBeCloseTo(2.8 / 2.3);
    expect(metrics.expectancy).toBeCloseTo(0.25);
    expect(metrics.averageHoldMinutes).toBe(60);
    expect(metrics.performanceBySymbol['BTC-USD']?.trades).toBe(1);
    expect(metrics.performanceBySymbol['ETH-USD']?.trades).toBe(1);
    expect(metrics.performanceByRegime.uptrend?.wins).toBe(1);
    expect(metrics.performanceByRegime.downtrend?.losses).toBe(1);
    expect(metrics.performanceByHourOfDay['0']?.trades).toBe(1);
    expect(metrics.performanceByHourOfDay['2']?.trades).toBe(1);
    expect(metrics.performanceByVolatilityBucket.medium?.trades).toBe(1);
    expect(metrics.performanceByVolatilityBucket.high?.trades).toBe(1);
  });
});
