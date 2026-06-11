/**
 * Asset-agnostic technical indicators.
 *
 * These are pure math over a price series — they do not care whether the
 * series is BTC-USD ticks or AAPL bars. They live in core (not a venue
 * package) precisely so crypto and equity strategies share one implementation,
 * which is the central premise of the equities-v1 PRD: the analysis engine is
 * asset-class neutral.
 *
 * (source-crypto-trade still carries its own candle-based copy with ATR/VWAP;
 * those are OHLCV-specific. The snapshot-stream indicators below are the subset
 * StrategyPlugins need and the canonical home for shared math going forward.)
 */

/** Exponential moving average series. Returns one value per input point. */
export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i]! * k + out[i - 1]! * (1 - k));
  }
  return out;
}

/** Simple moving average of the last `period` values. */
export function sma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const slice = values.slice(-Math.min(period, values.length));
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

/** Wilder's RSI over the series. Neutral 50 until enough data. */
export function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD line/signal/histogram (latest + previous histogram for slope). */
export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = values.map((_, i) => (fastEma[i] ?? 0) - (slowEma[i] ?? 0));
  const signalLine = ema(line, signal);
  const histogram = line.map((v, i) => v - (signalLine[i] ?? 0));
  return {
    line: line.at(-1) ?? 0,
    signal: signalLine.at(-1) ?? 0,
    histogram: histogram.at(-1) ?? 0,
    prevHistogram: histogram.at(-2) ?? 0,
  };
}
