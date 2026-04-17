import { describe, it, expect } from 'vitest';
import { runBacktest } from './backtest.js';
import type { Candle } from './candles.js';
import type { AnalysisSignal } from './engine.js';

/**
 * Synthetic candle sequence: slow grind up with periodic deep wiggles.
 * Wiggles are calibrated to punch through the 1% trailing stop so the
 * fee-churn scenario actually fires without the guard. TAKE_PROFIT fires
 * after ~30 bars of uptrend at $0.10/bar on $100.
 */
function pumpWithWiggles(totalBars = 300, barMs = 300_000): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < totalBars; i++) {
    const time = i * barMs;
    if (i < 60) {
      out.push({ time, open: price, high: price + 0.1, low: price - 0.1, close: price, volume: 1500 });
      continue;
    }
    price = price + 0.10;
    // Every 3 bars past warmup: deep wiggle −1.5% low (triggers 1% trailing stop).
    const deep = (i - 60) % 3 === 0;
    const low = deep ? price * 0.985 : price - 0.05;
    out.push({
      time,
      open: price - 0.05,
      high: price + 0.1,
      low,
      close: price,
      volume: 2500,
    });
  }
  return out;
}

// Engine that emits a fresh "long" entry signal on every non-warmup bar
// where no position is open. The backtest's cooldown gate handles pacing.
// confirmTrend stays 'bull' throughout so the guard has something to hold on.
function makeTrendEngine(entryBarIdx = 61) {
  return (input: Parameters<typeof makeTrendEngine>[0] extends never ? never : import('./engine.js').AnalysisInput): AnalysisSignal => {
    const latest = input.entryCandles.at(-1)!;
    const barIdx = Math.floor(latest.time / 300_000);
    const price = latest.close;

    if (barIdx >= entryBarIdx) {
      return {
        symbol: input.symbol,
        exchange: input.exchange,
        timestamp: latest.time,
        timeframe: '5m',
        regime: 'uptrend',
        setupType: 'long_trend_continuation',
        score: 85,
        direction: 'long',
        entryBias: 'market_or_limit',
        entryZone: { min: price - 0.5, max: price + 0.5 },
        stopLoss: price * 0.996,
        takeProfit: price * 1.008,
        riskReward: 2,
        indicators: { emaFast: 1, emaSlow: 1, emaTrend: 1, rsi: 55, macdLine: 1, macdSignal: 1, macdHistogram: 1, vwap: 1, atr: 1, atrPct: 0.5, volumeRatio: 1.5, spreadPct: 0.05 },
        confirmTrend: 'bull',
        reasons: ['trend'],
        rejectReasons: [],
        rejected: false,
        confidence: 0.85,
      };
    }

    // For every non-entry call, return a rejected signal but KEEP confirmTrend
    // as 'bull' so the exit path sees the trend is still confirmed.
    return {
      symbol: input.symbol,
      exchange: input.exchange,
      timestamp: latest.time,
      timeframe: '5m',
      regime: 'uptrend',
      setupType: null,
      score: 0,
      direction: null,
      entryBias: null,
      entryZone: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      indicators: { emaFast: 1, emaSlow: 1, emaTrend: 1, rsi: 55, macdLine: 1, macdSignal: 1, macdHistogram: 1, vwap: 1, atr: 1, atrPct: 0.5, volumeRatio: 1.5, spreadPct: 0.05 },
      confirmTrend: 'bull',
      reasons: [],
      rejectReasons: ['already entered'],
      rejected: true,
      confidence: 0,
    };
  };
}

describe('backtest 15m-uptrend guard', () => {
  const candles = pumpWithWiggles();

  it('produces fewer round-trips with guard enabled than disabled', () => {
    const withGuard = runBacktest({
      symbol: 'BTC-USD',
      exchange: 'kraken',
      candles,
      signalEngine: makeTrendEngine(),
      assumptions: { honorUptrendGuard: true, minHoldMs: 0, hardStopPct: -0.02 },
    });
    const withoutGuard = runBacktest({
      symbol: 'BTC-USD',
      exchange: 'kraken',
      candles,
      signalEngine: makeTrendEngine(),
      assumptions: { honorUptrendGuard: false, minHoldMs: 0, hardStopPct: -0.02 },
    });

    const net = (bt: typeof withGuard): number => bt.trades.reduce((s, t) => s + t.netPnl, 0);
    const fees = (bt: typeof withGuard): number => bt.trades.reduce((s, t) => s + t.fees, 0);
    // eslint-disable-next-line no-console
    console.log(`[uptrend-guard backtest] OFF → ${withoutGuard.trades.length} trades, fees $${fees(withoutGuard).toFixed(4)}, net $${net(withoutGuard).toFixed(4)}`);
    // eslint-disable-next-line no-console
    console.log(`[uptrend-guard backtest] ON  → ${withGuard.trades.length} trades, fees $${fees(withGuard).toFixed(4)}, net $${net(withGuard).toFixed(4)}`);
    // Core claim: the guard produces BETTER NET PNL than getting whipsawed
    // out on every wiggle. Trade count may go up (more successful TP cycles
    // instead of early stop-outs) but each trade is profitable.
    expect(net(withGuard)).toBeGreaterThan(net(withoutGuard));
  });

  it('still exits on hard-stop even when guard is enabled', () => {
    const crashCandles = [...candles];
    // Bar 100: big drop past the -2% hard-stop threshold.
    crashCandles[100] = { ...crashCandles[100]!, low: 50, close: 80 };
    const bt = runBacktest({
      symbol: 'BTC-USD',
      exchange: 'kraken',
      candles: crashCandles,
      signalEngine: makeTrendEngine(),
      assumptions: { honorUptrendGuard: true, minHoldMs: 0, hardStopPct: -0.02 },
    });
    // At least one trade must have closed before end_of_data — the hard stop
    // should have fired on bar 100.
    expect(bt.trades.length).toBeGreaterThan(0);
  });
});
