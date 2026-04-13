// @ts-nocheck
import { computePriceRange, priceToRow } from './priceScale.js';
import { drawMarkers } from './markerRenderer.js';

const UNICODE_GLYPHS = {
  vert: '│',
  open: '┤',
  close: '├',
  both: '┼',
  line: '─',
  long: '▲',
  short: '▼',
  exit: '✖',
};

const ASCII_GLYPHS = {
  vert: '|',
  open: '|',
  close: '|',
  both: '|',
  line: '-',
  long: '^',
  short: 'v',
  exit: 'x',
};

function colorize(text, color) {
  return color ? `{${color}-fg}${text}{/${color}-fg}` : text;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1000) return value.toFixed(2);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  if (Math.abs(value) >= 0.1) return value.toFixed(4);
  if (Math.abs(value) >= 0.01) return value.toFixed(5);
  return value.toFixed(6);
}

function makeGrid(rows, cols) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
}

export function renderChart({
  pair,
  exchange,
  timeframe,
  bars = [],
  markers = [],
  position = null,
  status = 'bootstrapping',
  currentPrice = null,
  currentPriceDirection = 'flat',
  lastUpdateTime = null,
  width = 80,
  height = 12,
  ascii = false,
}) {
  const headerWidth = Math.max(20, width);
  const plotRows = Math.max(6, height - 2);
  const rightLabelWidth = 12;
  const plotWidth = Math.max(12, headerWidth - rightLabelWidth - 1);
  const barStride = 3;
  const glyphs = ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;

  if (!bars.length) {
    const stateLabel = status.toUpperCase();
    return [
      `${colorize('Pair', 'cyan')}: ${pair}  ${colorize('TF', 'cyan')}: ${timeframe}  ${colorize('Status', status === 'live' ? 'green' : status === 'error' ? 'red' : 'yellow')}: ${stateLabel}`,
      ' Waiting for chart data...',
    ].join('\n');
  }

  const visibleCount = Math.max(8, Math.floor(plotWidth / barStride));
  const visibleBars = bars.slice(-visibleCount);
  const { min, max } = computePriceRange({ bars: visibleBars, markers, position, currentPrice });
  const grid = makeGrid(plotRows, plotWidth + rightLabelWidth);

  for (let index = 0; index < visibleBars.length; index += 1) {
    const bar = visibleBars[index];
    const x = index * barStride + 1;
    if (x >= plotWidth) break;
    const highRow = priceToRow(bar.high, min, max, plotRows);
    const lowRow = priceToRow(bar.low, min, max, plotRows);
    const openRow = priceToRow(bar.open, min, max, plotRows);
    const closeRow = priceToRow(bar.close, min, max, plotRows);
    const color = bar.close >= bar.open ? 'green' : 'red';
    for (let row = Math.min(highRow, lowRow); row <= Math.max(highRow, lowRow); row += 1) {
      if (grid[row]?.[x] != null) grid[row][x] = colorize(glyphs.vert, color);
    }
    if (openRow === closeRow) {
      if (grid[openRow]?.[x] != null) grid[openRow][x] = colorize(glyphs.both, color);
    } else {
      if (grid[openRow]?.[x] != null) grid[openRow][x] = colorize(glyphs.open, color);
      if (grid[closeRow]?.[x] != null) grid[closeRow][x] = colorize(glyphs.close, color);
    }
  }

  if (position?.isOpen && Number.isFinite(position.currentPrice)) {
    const lineRow = priceToRow(position.currentPrice, min, max, plotRows);
    for (let x = 0; x < plotWidth; x += 1) {
      if (grid[lineRow]?.[x] === ' ') grid[lineRow][x] = colorize(glyphs.line, 'cyan');
    }
    const label = `$${formatPrice(position.currentPrice)}`;
    for (let i = 0; i < label.length; i += 1) {
      const x = Math.min(plotWidth + i, plotWidth + rightLabelWidth - 1);
      if (grid[lineRow]?.[x] != null) grid[lineRow][x] = colorize(label[i], 'cyan');
    }
  }

  drawMarkers(grid, {
    markers,
    visibleBars,
    timeframe,
    minPrice: min,
    maxPrice: max,
    plotWidth,
    plotHeight: plotRows,
    rightLabelWidth,
    glyphs,
  });

  const topLabel = `$${formatPrice(max)}`;
  const bottomLabel = `$${formatPrice(min)}`;
  for (let i = 0; i < topLabel.length; i += 1) {
    grid[0][plotWidth + i] = topLabel[i];
  }
  for (let i = 0; i < bottomLabel.length; i += 1) {
    grid[plotRows - 1][plotWidth + i] = bottomLabel[i];
  }

  const lastBar = visibleBars.at(-1);
  const lastPrice = Number.isFinite(currentPrice) ? currentPrice : lastBar?.close ?? null;
  const lastPriceColor = currentPriceDirection === 'up' ? 'green' : currentPriceDirection === 'down' ? 'red' : 'white';
  const positionLabel = position?.isOpen
    ? ` ${colorize('Position', 'cyan')}: ${position.side?.toUpperCase() ?? 'OPEN'} @ $${formatPrice(position.entryPrice)}`
    : '';
  const ageLabel = lastUpdateTime ? `  ${colorize('Age', 'cyan')}: ${Math.max(0, Math.floor((Date.now() - lastUpdateTime) / 1000))}s` : '';
  const statusColor = status === 'live' ? 'green' : status === 'error' ? 'red' : status === 'stale' ? 'yellow' : 'white';
  const header = `${colorize('Pair', 'cyan')}: ${pair} @ ${exchange}  ${colorize('TF', 'cyan')}: ${timeframe}  ${colorize('Last', 'cyan')}: ${colorize(`$${formatPrice(lastPrice)}`, lastPriceColor)}  ${colorize('Status', statusColor)}: ${status.toUpperCase()}${positionLabel}${ageLabel}`;

  return [header, ...grid.map((row) => row.join(''))].join('\n');
}
