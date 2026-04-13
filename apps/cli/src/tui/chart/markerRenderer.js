// @ts-nocheck
import { bucketTime } from './timeframeAggregator.js';
import { priceToRow } from './priceScale.js';

export function drawMarkers(grid, {
  markers = [],
  visibleBars = [],
  timeframe = '1m',
  minPrice,
  maxPrice,
  plotWidth,
  plotHeight,
  rightLabelWidth,
  glyphs,
}) {
  if (!markers.length || !visibleBars.length) return;
  const indexByBucket = new Map();
  for (let i = 0; i < visibleBars.length; i += 1) {
    indexByBucket.set(bucketTime(visibleBars[i].time, timeframe), i);
  }
  const startX = 0;
  for (const marker of markers) {
    const bucket = bucketTime(marker.time, timeframe);
    const index = indexByBucket.get(bucket);
    if (index == null) continue;
    const x = startX + index * 2 + 1;
    if (x < 0 || x >= plotWidth) continue;
    const row = priceToRow(marker.price, minPrice, maxPrice, plotHeight);
    const symbol = marker.type === 'exit'
      ? glyphs.exit
      : marker.side === 'short'
        ? glyphs.short
        : glyphs.long;
    if (grid[row]?.[x]) {
      grid[row][x] = symbol;
    }
    const label = marker.label ? ` ${marker.label}` : '';
    if (!label) continue;
    const labelX = Math.min(plotWidth + 1, plotWidth + rightLabelWidth - label.length);
    for (let i = 0; i < label.length; i += 1) {
      if (grid[row]?.[labelX + i]) grid[row][labelX + i] = label[i];
    }
  }
}
