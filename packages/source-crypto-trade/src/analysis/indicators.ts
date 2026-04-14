import type { Candle } from './candles.js';

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [values[0]!];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i]! * k + result[i - 1]! * (1 - k));
  }
  return result;
}

export function sma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const slice = values.slice(-Math.min(period, values.length));
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

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

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = values.map((_, index) => (fastEma[index] ?? 0) - (slowEma[index] ?? 0));
  const signalLine = ema(line, signal);
  const histogram = line.map((value, index) => value - (signalLine[index] ?? 0));
  return {
    line: line.at(-1) ?? 0,
    signal: signalLine.at(-1) ?? 0,
    histogram: histogram.at(-1) ?? 0,
    prevHistogram: histogram.at(-2) ?? 0,
  };
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const ranges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i]!;
    const prev = candles[i - 1]!;
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close),
    ));
  }
  return sma(ranges, period);
}

export function intradayVwap(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  const last = candles.at(-1)!;
  const dayStart = new Date(last.time);
  dayStart.setUTCHours(0, 0, 0, 0);
  const todayBars = candles.filter((bar) => bar.time >= dayStart.getTime());
  let totalPv = 0;
  let totalVol = 0;
  for (const bar of todayBars) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    totalPv += typical * Math.max(bar.volume, 0);
    totalVol += Math.max(bar.volume, 0);
  }
  return totalVol > 0 ? totalPv / totalVol : last.close;
}

export function averageVolume(candles: Candle[], lookback = 20): number {
  return sma(candles.map((bar) => bar.volume), lookback);
}
