import { describe, expect, it } from 'vitest';
import type { AnalysisSignal } from './engine.js';
import type { Candle } from './candles.js';
import { runMultiPairBacktest } from './backtest.js';

function candle(time: number, high: number, low: number, close: number): Candle {
  return { time, open: close, high, low, close, volume: 1000 };
}

function flat(count: number, start = 0, step = 60_000): Candle[] {
  return Array.from({ length: count }, (_, i) => candle(start + i * step, 100.05, 99.95, 100));
}

/** Signal engine that fires long on every bar for every pair. */
function alwaysLong(score = 85): (input: { symbol: string; exchange: string; entryCandles: Candle[] }) => AnalysisSignal {
  return (input) => ({
    symbol: input.symbol,
    exchange: input.exchange,
    timestamp: input.entryCandles.at(-1)!.time,
    timeframe: '5m',
    regime: 'uptrend',
    setupType: 'long_trend_continuation',
    score,
    direction: 'long',
    entryBias: 'market_or_limit',
    entryZone: { min: 99.9, max: 100.1 },
    stopLoss: 99.6,
    takeProfit: 100.8,
    riskReward: 2,
    indicators: {
      emaFast: 1, emaSlow: 1, emaTrend: 1, rsi: 45, macdLine: 1, macdSignal: 1, macdHistogram: 1,
      vwap: 1, atr: 1, atrPct: 0.4, volumeRatio: 1.4, spreadPct: 0.05,
    },
    reasons: ['always long'],
    rejectReasons: [],
    rejected: false,
    confidence: 0.85,
  });
}

describe('runMultiPairBacktest — one position per exchange', () => {
  it('never opens two positions at once even when multiple pairs have signals', () => {
    const bars = flat(100);
    const result = runMultiPairBacktest({
      exchange: 'kraken',
      pairs: [
        { symbol: 'BTC-USD', candles: bars },
        { symbol: 'ETH-USD', candles: bars },
        { symbol: 'SOL-USD', candles: bars },
      ],
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: alwaysLong(),
    });

    // Verify no overlap in (entryTime, exitTime) across any two trades.
    const sorted = [...result.trades].sort((a, b) => a.entryTime - b.entryTime);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      expect(curr.entryTime).toBeGreaterThanOrEqual(prev.exitTime);
    }
  });

  it('counts signals skipped because another pair held the exchange position', () => {
    const bars = flat(30);
    const result = runMultiPairBacktest({
      exchange: 'kraken',
      pairs: [
        { symbol: 'BTC-USD', candles: bars },
        { symbol: 'ETH-USD', candles: bars },
        { symbol: 'SOL-USD', candles: bars },
      ],
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: alwaysLong(),
    });
    // While a position is open, the other 2 pairs' long signals should
    // register as "skipped for open position" — at least some non-zero count.
    expect(result.signalsSkippedForOpenPosition).toBeGreaterThan(0);
  });

  it('picks the highest-scoring signal when multiple fire on the same bar', () => {
    const bars = flat(30);
    let call = 0;
    const varyingScore = (input: { symbol: string; exchange: string; entryCandles: Candle[] }): AnalysisSignal => {
      call++;
      const scoreBySymbol: Record<string, number> = { 'BTC-USD': 70, 'ETH-USD': 95, 'SOL-USD': 80 };
      return {
        ...alwaysLong(scoreBySymbol[input.symbol] ?? 70)(input),
      };
    };
    const result = runMultiPairBacktest({
      exchange: 'kraken',
      pairs: [
        { symbol: 'BTC-USD', candles: bars },
        { symbol: 'ETH-USD', candles: bars },
        { symbol: 'SOL-USD', candles: bars },
      ],
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: varyingScore,
    });
    // First trade should be on ETH-USD (score 95, beats BTC 70 and SOL 80).
    expect(result.trades[0]?.symbol).toBe('ETH-USD');
    void call;
  });

  it('enforces per-pair cooldown across the multi-pair timeline', () => {
    const bars = flat(200);
    const result = runMultiPairBacktest({
      exchange: 'kraken',
      pairs: [{ symbol: 'BTC-USD', candles: bars }],
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: alwaysLong(),
    });
    for (let i = 1; i < result.trades.length; i++) {
      const prev = result.trades[i - 1]!;
      const curr = result.trades[i]!;
      if (prev.symbol !== curr.symbol) continue;
      expect(curr.entryTime - prev.exitTime).toBeGreaterThanOrEqual(3 * 60 * 1000);
    }
  });

  it('returns a perPair breakdown with trade counts and net P&L', () => {
    const bars = flat(50);
    const result = runMultiPairBacktest({
      exchange: 'kraken',
      pairs: [
        { symbol: 'BTC-USD', candles: bars },
        { symbol: 'ETH-USD', candles: bars },
      ],
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: alwaysLong(),
    });
    expect(result.perPair['BTC-USD']).toBeDefined();
    expect(result.perPair['ETH-USD']).toBeDefined();
    const totalInPerPair = Object.values(result.perPair).reduce((sum, b) => sum + b.trades, 0);
    expect(totalInPerPair).toBe(result.trades.length);
  });
});
