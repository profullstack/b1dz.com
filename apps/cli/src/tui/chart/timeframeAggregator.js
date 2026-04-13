// @ts-nocheck
export const TIMEFRAME_TO_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

export const TIMEFRAME_KEYS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

export function bucketTime(time, timeframe) {
  const ms = TIMEFRAME_TO_MS[timeframe] ?? TIMEFRAME_TO_MS['1m'];
  return Math.floor(time / ms) * ms;
}

export function normalizeBar(bar) {
  const time = Number(bar.time);
  const open = Number(bar.open);
  const high = Number(bar.high);
  const low = Number(bar.low);
  const close = Number(bar.close);
  const volume = bar.volume == null ? undefined : Number(bar.volume);
  if (![time, open, high, low, close].every(Number.isFinite)) return null;
  return { time, open, high, low, close, ...(Number.isFinite(volume) ? { volume } : {}) };
}

export function aggregateBars(inputBars, timeframe) {
  const buckets = new Map();
  for (const candidate of inputBars ?? []) {
    const bar = normalizeBar(candidate);
    if (!bar) continue;
    const time = bucketTime(bar.time, timeframe);
    const current = buckets.get(time);
    if (!current) {
      buckets.set(time, {
        time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume ?? 0,
      });
      continue;
    }
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    if (Number.isFinite(bar.volume)) current.volume = (current.volume ?? 0) + bar.volume;
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

export function makeBarFromPrice(time, price, timeframe) {
  const bucket = bucketTime(time, timeframe);
  return {
    time: bucket,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
  };
}
