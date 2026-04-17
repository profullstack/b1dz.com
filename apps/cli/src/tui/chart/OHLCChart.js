// @ts-nocheck
import React from 'react';
import { renderChart } from './chartRenderer.js';

export function OHLCChart({
  bars = [],
  markers = [],
  position = null,
  status = 'bootstrapping',
  width = '100%',
  height = 12,
  renderWidth = 80,
  renderHeight = height,
  pair = 'BTC-USD',
  exchange = 'kraken',
  timeframe = '1m',
  currentPrice = null,
  currentPriceDirection = 'flat',
  lastUpdateTime = null,
  ascii = false,
  indicators = { ema: false, sma: false, bollinger: false },
  ...boxProps
}) {
  const content = renderChart({
    pair,
    exchange,
    timeframe,
    bars,
    markers,
    position,
    status,
    currentPrice,
    currentPriceDirection,
    lastUpdateTime,
    width: renderWidth,
    height: renderHeight,
    ascii,
    indicators,
  });

  return React.createElement('box', {
    tags: true,
    content,
    ...boxProps,
  });
}

export default OHLCChart;
