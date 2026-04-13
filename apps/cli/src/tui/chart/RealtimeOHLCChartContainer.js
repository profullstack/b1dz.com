// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createCandleStore } from './candleStore.js';
import { fetchHistoricalBars, createLiveFeed } from './marketFeed.js';
import { OHLCChart } from './OHLCChart.js';

function parseElapsedMs(elapsed) {
  const match = /^(\d+)([smhd])$/.exec(elapsed ?? '');
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * mult;
}

function toMarker(trade, type, side, price, time) {
  return {
    id: `${trade.exchange}:${trade.pair}:${type}:${time}`,
    time,
    price,
    type,
    side,
    label: type === 'exit' ? `${trade.netPnl >= 0 ? '+' : ''}$${trade.netPnl.toFixed(2)}` : trade.strategyId,
  };
}

export function RealtimeOHLCChartContainer({
  pair,
  exchange,
  timeframe = '1m',
  defaultTimeframe = '1m',
  width = 80,
  boxWidth = '100%',
  height = 12,
  positions = [],
  closedTrades = [],
  bootstrapBars = 120,
  top = 0,
  left = 0,
  label = ' OHLC Chart ',
}) {
  const activeTimeframe = timeframe || defaultTimeframe;
  const storeRef = useRef(createCandleStore({ timeframe: activeTimeframe, maxBars: Math.max(bootstrapBars * 2, 500) }));
  const runRef = useRef(0);
  const [bars, setBars] = useState([]);
  const [status, setStatus] = useState('bootstrapping');
  const [lastUpdateTime, setLastUpdateTime] = useState(null);
  const [currentPrice, setCurrentPrice] = useState(null);
  const [currentPriceDirection, setCurrentPriceDirection] = useState('flat');

  const position = useMemo(() => {
    const active = positions.find((item) => item.exchange === exchange && item.pair === pair);
    if (!active) return { isOpen: false, side: null, entryPrice: null, currentPrice: null };
    return {
      isOpen: true,
      side: 'long',
      entryPrice: active.entryPrice,
      currentPrice: Number.isFinite(active.currentPrice) ? active.currentPrice : currentPrice,
      quantity: active.volume,
      unrealizedPnl: active.pnlUsd,
    };
  }, [positions, exchange, pair, currentPrice]);

  const markers = useMemo(() => {
    const relevantClosed = closedTrades.filter((trade) => trade.exchange === exchange && trade.pair === pair);
    const nextMarkers = [];
    for (const trade of relevantClosed) {
      nextMarkers.push(toMarker(trade, 'entry', 'long', trade.entryPrice, trade.entryTime));
      nextMarkers.push(toMarker(trade, 'exit', 'long', trade.exitPrice, trade.exitTime));
    }
    if (position.isOpen && Number.isFinite(position.entryPrice)) {
      const openTrade = positions.find((item) => item.exchange === exchange && item.pair === pair);
      if (openTrade) {
        nextMarkers.push({
          id: `${exchange}:${pair}:open-entry:${openTrade.elapsed}`,
          time: Date.now() - parseElapsedMs(openTrade.elapsed),
          price: openTrade.entryPrice,
          type: 'entry',
          side: 'long',
          label: 'OPEN',
        });
      }
    }
    return nextMarkers;
  }, [closedTrades, exchange, pair, position.isOpen, position.entryPrice, positions]);

  useEffect(() => {
    runRef.current += 1;
    const runId = runRef.current;
    storeRef.current.reset(activeTimeframe);
    setBars([]);
    setStatus('bootstrapping');
    setCurrentPrice(position.isOpen ? position.currentPrice : null);
    setCurrentPriceDirection('flat');
    setLastUpdateTime(null);

    let stopLiveFeed = () => {};

    (async () => {
      const historical = await fetchHistoricalBars({ pair, exchange, timeframe: activeTimeframe, limit: bootstrapBars });
      if (runRef.current !== runId) return;
      storeRef.current.replace(historical, activeTimeframe);
      setBars(storeRef.current.getBars());
      if (historical.length === 0) {
        setStatus('error');
      }

      stopLiveFeed = createLiveFeed({
        pair,
        exchange,
        onStatus(nextStatus) {
          if (runRef.current !== runId) return;
          setStatus((prev) => (nextStatus === 'live' && prev === 'error' ? 'live' : nextStatus));
        },
        onTick(tick) {
          if (runRef.current !== runId) return;
          const changed = storeRef.current.applyTick(tick);
          if (!changed) return;
          setBars(storeRef.current.getBars());
          setCurrentPrice((prev) => {
            setCurrentPriceDirection(
              Number.isFinite(prev) && Number.isFinite(tick.price)
                ? tick.price > prev
                  ? 'up'
                  : tick.price < prev
                    ? 'down'
                    : 'flat'
                : 'flat',
            );
            return tick.price;
          });
          setLastUpdateTime(tick.time);
        },
      });
    })().catch(() => {
      if (runRef.current !== runId) return;
      setStatus('error');
    });

    return () => {
      stopLiveFeed();
    };
  }, [pair, exchange, activeTimeframe, bootstrapBars]);

  return React.createElement(OHLCChart, {
    top,
    left,
    width: boxWidth,
    height,
    renderWidth: width,
    renderHeight: height - 2,
    label,
    border: { type: 'line' },
    tags: true,
    style: { border: { fg: 'cyan' } },
    pair,
    exchange,
    timeframe: activeTimeframe,
    bars,
    markers,
    position,
    status,
    currentPrice,
    currentPriceDirection,
    lastUpdateTime,
    ascii: process.env.B1DZ_ASCII_CHARTS === 'true',
  });
}

export default RealtimeOHLCChartContainer;
