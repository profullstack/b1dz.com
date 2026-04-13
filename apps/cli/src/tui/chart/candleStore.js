// @ts-nocheck
import { makeBarFromPrice, normalizeBar, bucketTime } from './timeframeAggregator.js';

export function createCandleStore({ timeframe = '1m', maxBars = 500 } = {}) {
  let activeTimeframe = timeframe;
  let bars = [];
  let lastUpdateTime = null;
  let lastPrice = null;

  function trim() {
    if (bars.length > maxBars) {
      bars = bars.slice(-maxBars);
    }
  }

  return {
    replace(nextBars = [], nextTimeframe = activeTimeframe) {
      activeTimeframe = nextTimeframe;
      bars = nextBars.map(normalizeBar).filter(Boolean).sort((a, b) => a.time - b.time);
      trim();
      const last = bars.at(-1) ?? null;
      lastUpdateTime = last?.time ?? null;
      lastPrice = last?.close ?? null;
    },

    reset(nextTimeframe = activeTimeframe) {
      activeTimeframe = nextTimeframe;
      bars = [];
      lastUpdateTime = null;
      lastPrice = null;
    },

    applyTick(tick) {
      const price = Number(tick?.price);
      const time = Number(tick?.time);
      const volume = Number(tick?.volume);
      if (!Number.isFinite(price) || !Number.isFinite(time) || price <= 0) return false;

      const bucket = bucketTime(time, activeTimeframe);
      const current = bars.at(-1);
      if (!current || current.time !== bucket) {
        const bar = makeBarFromPrice(time, price, activeTimeframe);
        if (Number.isFinite(volume) && volume > 0) bar.volume = volume;
        bars.push(bar);
        trim();
      } else {
        current.high = Math.max(current.high, price);
        current.low = Math.min(current.low, price);
        current.close = price;
        if (Number.isFinite(volume) && volume > 0) {
          current.volume = (Number.isFinite(current.volume) ? current.volume : 0) + volume;
        }
      }
      lastUpdateTime = time;
      lastPrice = price;
      return true;
    },

    getBars() {
      return bars.slice();
    },

    getLastUpdateTime() {
      return lastUpdateTime;
    },

    getLastPrice() {
      return lastPrice;
    },
  };
}
