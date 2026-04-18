import { describe, expect, it } from 'vitest';
import type { AnalysisSignal } from './engine.js';
import type { Candle } from './candles.js';
import { runBacktest } from './backtest.js';
import {
  BREAKEVEN_TRIGGER_PCT,
  COOLDOWN_MS,
  INITIAL_STOP_PCT,
  LOCK_STOP_PCT,
  LOCK_TRIGGER_PCT,
  TAKE_PROFIT_PCT,
  TIME_EXIT_FLAT_PCT,
  TIME_EXIT_MS,
} from '../trade-config.js';

function candle(time: number, high: number, low: number, close: number): Candle {
  return { time, open: close, high, low, close, volume: 1000 };
}

/** Build a stub analysis signal that fires exactly once at a given candle time. */
function onceAtTime(targetTime: number): (input: { symbol: string; exchange: string; entryCandles: Candle[] }) => AnalysisSignal {
  let emitted = false;
  return (input) => {
    const latest = input.entryCandles.at(-1)!;
    const shouldEmit = !emitted && latest.time === targetTime;
    if (shouldEmit) emitted = true;
    return {
      symbol: input.symbol,
      exchange: input.exchange,
      timestamp: latest.time,
      timeframe: '5m',
      regime: 'uptrend',
      setupType: shouldEmit ? 'long_trend_continuation' : null,
      score: shouldEmit ? 85 : 0,
      direction: shouldEmit ? 'long' : null,
      entryBias: shouldEmit ? 'market_or_limit' : null,
      entryZone: shouldEmit ? { min: latest.close - 0.1, max: latest.close + 0.1 } : null,
      stopLoss: shouldEmit ? latest.close * 0.99 : null,
      takeProfit: shouldEmit ? latest.close * 1.02 : null,
      riskReward: shouldEmit ? 2 : null,
      indicators: {
        emaFast: 1, emaSlow: 1, emaTrend: 1, rsi: 45, macdLine: 1, macdSignal: 1, macdHistogram: 1,
        vwap: 1, atr: 1, atrPct: 0.4, volumeRatio: 1.4, spreadPct: 0.05,
      },
      reasons: shouldEmit ? ['stub entry'] : [],
      rejectReasons: shouldEmit ? [] : ['stub reject'],
      rejected: !shouldEmit,
      confidence: shouldEmit ? 0.85 : 0,
    };
  };
}

describe('backtest live-parity', () => {
  it('exits a winning position at the fixed TAKE_PROFIT_PCT target (not ATR target)', () => {
    const bars: Candle[] = [
      ...Array.from({ length: 20 }, (_, i) => candle(i * 300_000, 100.1, 99.9, 100)),
    ];
    const entryTime = 15 * 300_000;
    // Price walks up past the TP: entry at 100 → TP at 100 * (1 + 0.015) = 101.5
    bars[16] = candle(16 * 300_000, 102, 100, 101.8);
    const result = runBacktest({
      symbol: 'TEST-USD',
      exchange: 'kraken',
      candles: bars,
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: onceAtTime(entryTime),
    });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    const expectedTp = trade.entryPrice * (1 + TAKE_PROFIT_PCT);
    expect(trade.exitPrice).toBeCloseTo(expectedTp, 5);
  });

  it('exits a losing position at the fixed INITIAL_STOP_PCT (not ATR stop)', () => {
    const bars: Candle[] = [
      ...Array.from({ length: 20 }, (_, i) => candle(i * 300_000, 100.1, 99.9, 100)),
    ];
    const entryTime = 15 * 300_000;
    // Next bar drops below the 0.4% initial stop (below 99.6)
    bars[16] = candle(16 * 300_000, 100.05, 99, 99.1);
    const result = runBacktest({
      symbol: 'TEST-USD',
      exchange: 'kraken',
      candles: bars,
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: onceAtTime(entryTime),
    });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    const expectedStop = trade.entryPrice * (1 - INITIAL_STOP_PCT);
    expect(trade.exitPrice).toBeCloseTo(expectedStop, 5);
  });

  it('locks in profit at +LOCK_STOP_PCT once price crosses LOCK_TRIGGER_PCT', () => {
    const bars: Candle[] = [
      ...Array.from({ length: 20 }, (_, i) => candle(i * 300_000, 100.1, 99.9, 100)),
    ];
    const entryTime = 15 * 300_000;
    // Bar 16: price spikes past LOCK_TRIGGER (+0.5%) but doesn't hit TP.
    //         High moves HWM to 100.6 so next bar's trailing stop becomes
    //         entry × (1 + LOCK_STOP_PCT) = 100.2.
    bars[16] = candle(16 * 300_000, 100.6, 100, 100.5);
    // Bar 17: price pulls back, low dips to 100.1 (below 100.2 lock stop).
    bars[17] = candle(17 * 300_000, 100.3, 100.1, 100.15);
    const result = runBacktest({
      symbol: 'TEST-USD',
      exchange: 'kraken',
      candles: bars,
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: onceAtTime(entryTime),
    });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    const expectedLockStop = trade.entryPrice * (1 + LOCK_STOP_PCT);
    expect(trade.exitPrice).toBeCloseTo(expectedLockStop, 5);
    expect(trade.exitPrice).toBeGreaterThan(trade.entryPrice);
  });

  it('applies time-based flat exit after TIME_EXIT_MS when pnl is within ±TIME_EXIT_FLAT_PCT', () => {
    const timeExitBars = Math.ceil(TIME_EXIT_MS / 300_000);
    const bars: Candle[] = Array.from({ length: 50 }, (_, i) => candle(i * 300_000, 100.05, 99.95, 100));
    const entryTime = 5 * 300_000;
    const result = runBacktest({
      symbol: 'TEST-USD',
      exchange: 'kraken',
      candles: bars,
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: onceAtTime(entryTime),
    });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.holdMinutes).toBeGreaterThanOrEqual(TIME_EXIT_MS / 60_000);
    // Exit should be at close (time_exit uses close price), which is ~100.
    expect(Math.abs((trade.exitPrice - trade.entryPrice) / trade.entryPrice)).toBeLessThan(TIME_EXIT_FLAT_PCT * 1.01);
    void timeExitBars;
  });

  it('enforces cooldown between trades on the same pair', () => {
    const bars: Candle[] = Array.from({ length: 100 }, (_, i) => candle(i * 60_000, 100.05, 99.95, 100));
    // Stub: emit signal on every single call. The backtest should skip the
    // second entry until the cooldown passes.
    const engine = (input: { symbol: string; exchange: string; entryCandles: Candle[] }) => ({
      symbol: input.symbol,
      exchange: input.exchange,
      timestamp: input.entryCandles.at(-1)!.time,
      timeframe: '5m' as const,
      regime: 'uptrend' as const,
      setupType: 'long_trend_continuation' as const,
      score: 85,
      direction: 'long' as const,
      entryBias: 'market_or_limit' as const,
      entryZone: { min: 99.9, max: 100.1 },
      stopLoss: 99, takeProfit: 101, riskReward: 2,
      indicators: {
        emaFast: 1, emaSlow: 1, emaTrend: 1, rsi: 45, macdLine: 1, macdSignal: 1, macdHistogram: 1,
        vwap: 1, atr: 1, atrPct: 0.4, volumeRatio: 1.4, spreadPct: 0.05,
      },
      reasons: ['always'], rejectReasons: [], rejected: false, confidence: 0.85,
    });
    const result = runBacktest({
      symbol: 'TEST-USD',
      exchange: 'kraken',
      candles: bars,
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: engine,
    });
    // Consecutive trade entry times must be at least COOLDOWN_MS apart.
    for (let i = 1; i < result.trades.length; i++) {
      const prev = result.trades[i - 1]!;
      const curr = result.trades[i]!;
      expect(curr.entryTime - prev.exitTime).toBeGreaterThanOrEqual(COOLDOWN_MS);
    }
  });

  it('sets haltedByDailyLossLimit once cumulative UTC-day losses exceed the limit', () => {
    // 1 bar per minute, no volatility → forces TIME_EXIT flat close.
    // All entries will be flat-exit losers at 0 net (fees=0), so the daily
    // limit shouldn't trip. That verifies the halt ONLY fires when losses
    // actually exceed threshold.
    const bars: Candle[] = Array.from({ length: 200 }, (_, i) => candle(i * 60_000, 100.05, 99.95, 100));
    const engine = () => ({
      symbol: 'TEST-USD', exchange: 'kraken', timestamp: 0, timeframe: '5m' as const,
      regime: 'uptrend' as const, setupType: 'long_trend_continuation' as const,
      score: 85, direction: 'long' as const, entryBias: 'market_or_limit' as const,
      entryZone: { min: 99.9, max: 100.1 }, stopLoss: 99, takeProfit: 101, riskReward: 2,
      indicators: {
        emaFast: 1, emaSlow: 1, emaTrend: 1, rsi: 45, macdLine: 1, macdSignal: 1, macdHistogram: 1,
        vwap: 1, atr: 1, atrPct: 0.4, volumeRatio: 1.4, spreadPct: 0.05,
      },
      reasons: ['always'], rejectReasons: [], rejected: false, confidence: 0.85,
    });
    const cleanResult = runBacktest({
      symbol: 'TEST-USD', exchange: 'kraken', candles: bars,
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: engine,
    });
    expect(cleanResult.haltedByDailyLossLimit).toBe(false);

    // Now force realistic fees (0.006 per side, 1.2% round trip) so every
    // time-exit trade nets -~1.2% = -$1.20 on $100 equity. Need about 5
    // trades to cumulate -$5 = -5% of $100 starting equity → halt trips.
    const haltedResult = runBacktest({
      symbol: 'TEST-USD', exchange: 'kraken', candles: bars,
      assumptions: { feeRate: 0.006, slippagePct: 0, spreadPct: 0 },
      signalEngine: engine,
    });
    expect(haltedResult.haltedByDailyLossLimit).toBe(true);
  });

  it('ignores non-long signals (live daemon does not short)', () => {
    const bars: Candle[] = Array.from({ length: 50 }, (_, i) => candle(i * 300_000, 100.1, 99.9, 100));
    const engine = (input: { symbol: string; exchange: string; entryCandles: Candle[] }) => ({
      symbol: input.symbol, exchange: input.exchange,
      timestamp: input.entryCandles.at(-1)!.time, timeframe: '5m' as const,
      regime: 'downtrend' as const, setupType: 'short_trend_continuation' as const,
      score: 90, direction: 'short' as const, entryBias: 'market_or_limit' as const,
      entryZone: { min: 99.9, max: 100.1 }, stopLoss: 101, takeProfit: 98, riskReward: 2,
      indicators: {
        emaFast: 1, emaSlow: 1, emaTrend: 1, rsi: 60, macdLine: 1, macdSignal: 1, macdHistogram: 1,
        vwap: 1, atr: 1, atrPct: 0.4, volumeRatio: 1.4, spreadPct: 0.05,
      },
      reasons: ['short'], rejectReasons: [], rejected: false, confidence: 0.9,
    });
    const result = runBacktest({
      symbol: 'TEST-USD', exchange: 'kraken', candles: bars,
      assumptions: { feeRate: 0, slippagePct: 0, spreadPct: 0 },
      signalEngine: engine,
    });
    expect(result.trades).toHaveLength(0);
  });

  it('uses the same BREAKEVEN_TRIGGER_PCT constant the live daemon does', () => {
    expect(BREAKEVEN_TRIGGER_PCT).toBe(0.003);
    expect(TAKE_PROFIT_PCT).toBe(0.015);
    expect(INITIAL_STOP_PCT).toBe(0.004);
    expect(LOCK_TRIGGER_PCT).toBe(0.005);
    expect(LOCK_STOP_PCT).toBe(0.002);
    expect(COOLDOWN_MS).toBe(3 * 60 * 1000);
    expect(TIME_EXIT_MS).toBe(15 * 60 * 1000);
  });
});
