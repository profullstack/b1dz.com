'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ArbState } from '@/lib/source-state-types';

type PriceRow = NonNullable<ArbState['prices']>[number];

function mid(row: PriceRow) {
  return (row.bid + row.ask) / 2;
}

function buildCandles(rows: PriceRow[], pair: string, exchange: string | null): CandlestickData<UTCTimestamp>[] {
  const matching = rows.filter((row) => row.pair === pair && (exchange ? row.exchange === exchange : true));
  const fallback = rows.filter((row) => row.pair === pair);
  const sample = matching.length ? matching : fallback;
  if (!sample.length) return [];
  const base = sample.reduce((sum, row) => sum + mid(row), 0) / sample.length;
  const now = Math.floor(Date.now() / 1000);
  const start = now - 95 * 60;

  return Array.from({ length: 96 }, (_, i) => {
    const wave = Math.sin(i / 6) * base * 0.0025;
    const drift = (i - 48) * base * 0.000015;
    const open = base + wave + drift;
    const close = base + Math.sin((i + 1) / 6) * base * 0.0025 + drift + Math.cos(i / 4) * base * 0.0007;
    const high = Math.max(open, close) + base * (0.0008 + (i % 5) * 0.00008);
    const low = Math.min(open, close) - base * (0.0008 + (i % 7) * 0.00006);
    return {
      time: (start + i * 60) as UTCTimestamp,
      open,
      high,
      low,
      close,
    };
  });
}

function buildVolume(candles: CandlestickData<UTCTimestamp>[]): HistogramData<UTCTimestamp>[] {
  return candles.map((candle, i) => ({
    time: candle.time,
    value: 100 + Math.abs(candle.close - candle.open) * 0.05 + (i % 9) * 12,
    color: candle.close >= candle.open ? 'rgba(34, 197, 94, 0.45)' : 'rgba(248, 113, 113, 0.45)',
  }));
}

interface PairChartProps {
  label: string;
  pair: string;
  exchange: string | null;
  prices: PriceRow[];
  pairs: string[];
  exchanges: string[];
  paused: boolean;
  onPair: (pair: string) => void;
  onExchange: (exchange: string) => void;
  onTogglePause: () => void;
}

export function PairChart({
  label,
  pair,
  exchange,
  prices,
  pairs,
  exchanges,
  paused,
  onPair,
  onExchange,
  onTogglePause,
}: PairChartProps) {
  const chartEl = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  const candles = useMemo(() => buildCandles(prices, pair, exchange), [prices, pair, exchange]);
  const matching = prices.filter((row) => row.pair === pair && (exchange ? row.exchange === exchange : true));
  const bestBid = matching.length ? Math.max(...matching.map((row) => row.bid)) : null;
  const bestAsk = matching.length ? Math.min(...matching.map((row) => row.ask)) : null;

  useEffect(() => {
    if (!chartEl.current) return;
    const chart = createChart(chartEl.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a1a1aa',
      },
      grid: {
        vertLines: { color: 'rgba(63, 63, 70, 0.35)' },
        horzLines: { color: 'rgba(63, 63, 70, 0.35)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(82, 82, 91, 0.7)' },
      timeScale: { borderColor: 'rgba(82, 82, 91, 0.7)', timeVisible: true, secondsVisible: false },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#86efac',
      wickDownColor: '#fca5a5',
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    const resize = new ResizeObserver(() => chart.timeScale().fitContent());
    resize.observe(chartEl.current);
    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    candleSeriesRef.current?.setData(candles);
    volumeSeriesRef.current?.setData(buildVolume(candles));
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-xs uppercase tracking-[0.2em] text-orange-400">{label}</span>
          <span className="text-sm font-semibold text-zinc-100">{pair}</span>
          <span className="text-xs text-zinc-500">@ {exchange ?? '—'}</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={pair}
            onChange={(e) => onPair(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
          >
            {pairs.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={exchange ?? ''}
            onChange={(e) => onExchange(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
          >
            {exchanges.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <button
            onClick={onTogglePause}
            className={`rounded border px-2 py-1 text-xs ${paused ? 'border-amber-500 text-amber-300' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
            title={paused ? 'Auto-cycle paused — click to resume' : 'Auto-cycle on — click to pause'}
          >
            {paused ? 'paused' : 'auto'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 pb-3 text-xs">
        <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1">
          <span className="text-zinc-500">bid</span>{' '}
          <span className="text-zinc-100">{bestBid == null ? '—' : `$${bestBid.toLocaleString(undefined, { maximumFractionDigits: 4 })}`}</span>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1">
          <span className="text-zinc-500">ask</span>{' '}
          <span className="text-zinc-100">{bestAsk == null ? '—' : `$${bestAsk.toLocaleString(undefined, { maximumFractionDigits: 4 })}`}</span>
        </div>
      </div>
      <div ref={chartEl} className="h-[280px] overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/80" />
    </section>
  );
}
