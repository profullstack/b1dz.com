// @ts-nocheck
/**
 * Indicator utilities used by the TUI chart overlay.
 *
 * All functions take an OHLC bar series (ascending by time) and return
 * an array the same length, filled with NaN for bars where the window
 * isn't yet satisfied.
 */

/** Simple moving average over `period` closes. */
export function sma(bars, period) {
  const out = new Array(bars.length).fill(NaN);
  if (!Number.isFinite(period) || period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const c = bars[i]?.close;
    if (!Number.isFinite(c)) {
      out[i] = NaN;
      continue;
    }
    sum += c;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average. Seeded with the first SMA over `period`. */
export function ema(bars, period) {
  const out = new Array(bars.length).fill(NaN);
  if (!Number.isFinite(period) || period <= 0 || bars.length === 0) return out;
  const k = 2 / (period + 1);
  // Seed: SMA of the first `period` closes.
  if (bars.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += bars[i].close;
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < bars.length; i += 1) {
    out[i] = bars[i].close * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Bollinger Bands: { middle, upper, lower } where middle is SMA(period)
 *  and upper/lower are middle ± stdDevs × rolling σ of the closes. */
export function bollinger(bars, period = 20, stdDevs = 2) {
  const middle = sma(bars, period);
  const upper = new Array(bars.length).fill(NaN);
  const lower = new Array(bars.length).fill(NaN);
  for (let i = period - 1; i < bars.length; i += 1) {
    const mean = middle[i];
    if (!Number.isFinite(mean)) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const diff = bars[j].close - mean;
      variance += diff * diff;
    }
    const sigma = Math.sqrt(variance / period);
    upper[i] = mean + stdDevs * sigma;
    lower[i] = mean - stdDevs * sigma;
  }
  return { middle, upper, lower };
}
