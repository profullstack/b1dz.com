// @ts-nocheck
export function computePriceRange({ bars = [], markers = [], position = null, currentPrice = null }) {
  const prices = [];
  for (const bar of bars) {
    if (Number.isFinite(bar.high)) prices.push(bar.high);
    if (Number.isFinite(bar.low)) prices.push(bar.low);
  }
  for (const marker of markers) {
    if (Number.isFinite(marker?.price)) prices.push(marker.price);
  }
  if (position?.isOpen && Number.isFinite(position.currentPrice)) prices.push(position.currentPrice);
  if (Number.isFinite(currentPrice)) prices.push(currentPrice);

  if (prices.length === 0) {
    return { min: 0, max: 1 };
  }

  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.02, 0.01);
    return { min: min - pad, max: max + pad };
  }
  const pad = Math.max((max - min) * 0.08, max * 0.0025);
  return { min: min - pad, max: max + pad };
}

export function priceToRow(price, min, max, rows) {
  if (!Number.isFinite(price) || !Number.isFinite(min) || !Number.isFinite(max) || rows <= 1) return 0;
  if (max === min) return Math.floor(rows / 2);
  const ratio = (max - price) / (max - min);
  return Math.max(0, Math.min(rows - 1, Math.round(ratio * (rows - 1))));
}
