import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '@b1dz/core';
import type { Candle } from './candles.js';
import { analyzeSignal } from './engine.js';

function snap(price: number, ts: number): MarketSnapshot {
  return {
    exchange: 'kraken',
    pair: 'BTC-USD',
    bid: price,
    ask: price + 0.1,
    bidSize: 12,
    askSize: 11,
    ts,
  };
}

function candle(time: number, open: number, high: number, low: number, close: number, volume: number): Candle {
  return { time, open, high, low, close, volume };
}

function makeTrendCandles(length: number, step: number, volumeBase = 1000): Candle[] {
  let price = 100;
  return Array.from({ length }, (_, index) => {
    const prev = price;
    price += step;
    return candle(
      index * 300_000,
      prev,
      price + 0.4,
      prev - 0.2,
      price,
      volumeBase + (index % 5) * 80,
    );
  });
}

function makeSidewaysCandles(length: number, volumeBase = 800): Candle[] {
  return Array.from({ length }, (_, index) => {
    const base = 100 + Math.sin(index / 4) * 0.25;
    return candle(
      index * 300_000,
      base - 0.05,
      base + 0.15,
      base - 0.15,
      base,
      volumeBase + (index % 3) * 10,
    );
  });
}

describe('analysis engine contract', () => {
  it('emits a structured long trend continuation setup in bullish conditions', () => {
    const entryCandles = makeTrendCandles(80, 0.35, 1400);
    const confirmCandles = makeTrendCandles(50, 0.35, 1500);
    const biasCandles = makeTrendCandles(70, 0.25, 1700);
    entryCandles[entryCandles.length - 1]!.volume = 2600;
    const latest = snap(entryCandles.at(-1)!.close, entryCandles.at(-1)!.time + 1000);

    const analysis = analyzeSignal({
      symbol: 'BTC-USD',
      exchange: 'kraken',
      latest,
      entryCandles,
      confirmCandles,
      biasCandles,
    });

    expect(analysis.rejected).toBe(false);
    expect(analysis.direction).toBe('long');
    expect(analysis.setupType).toBe('long_trend_continuation');
    expect(analysis.score).toBeGreaterThanOrEqual(65);
    expect(analysis.entryZone).not.toBeNull();
    expect(analysis.stopLoss).not.toBeNull();
    expect(analysis.takeProfit).not.toBeNull();
    expect(analysis.reasons.length).toBeGreaterThan(0);
  });

  it('rejects weak sideways long setups with clear reject reasons', () => {
    const entryCandles = makeSidewaysCandles(80);
    const confirmCandles = makeSidewaysCandles(50);
    const biasCandles = makeSidewaysCandles(70);
    const latest = snap(entryCandles.at(-1)!.close, entryCandles.at(-1)!.time + 1000);

    const analysis = analyzeSignal({
      symbol: 'BTC-USD',
      exchange: 'kraken',
      latest,
      entryCandles,
      confirmCandles,
      biasCandles,
    });

    expect(analysis.rejected).toBe(true);
    expect(analysis.rejectReasons.join(' ')).toMatch(/score|volume ratio|no valid setup|sideways/i);
  });

  it('rejects setups when spread exceeds the configured maximum', () => {
    const entryCandles = makeTrendCandles(80, 0.3, 1400);
    const confirmCandles = makeTrendCandles(50, 0.4, 1400);
    const biasCandles = makeTrendCandles(70, 0.6, 1400);
    const close = entryCandles.at(-1)!.close;
    const latest: MarketSnapshot = {
      exchange: 'kraken',
      pair: 'BTC-USD',
      bid: close,
      ask: close * 1.01,
      bidSize: 4,
      askSize: 3,
      ts: entryCandles.at(-1)!.time + 1000,
    };

    const analysis = analyzeSignal({
      symbol: 'BTC-USD',
      exchange: 'kraken',
      latest,
      entryCandles,
      confirmCandles,
      biasCandles,
    });

    expect(analysis.rejected).toBe(true);
    expect(analysis.rejectReasons.some((reason) => reason.includes('spread'))).toBe(true);
  });
});
