'use client';

import { useEffect, useRef, useState } from 'react';
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

interface RawBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const REFRESH_MS = 10_000;

const SUPPORTED_EXCHANGES = new Set(['coinbase', 'kraken', 'binance-us', 'binanceus', 'gemini']);

function toCandleData(bars: RawBar[]): CandlestickData<UTCTimestamp>[] {
  return bars.map((b) => ({
    time: Math.floor(b.time / 1000) as UTCTimestamp,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
}

function toVolumeData(bars: RawBar[]): HistogramData<UTCTimestamp>[] {
  return bars.map((b) => ({
    time: Math.floor(b.time / 1000) as UTCTimestamp,
    value: b.volume,
    color: b.close >= b.open ? 'rgba(34, 197, 94, 0.45)' : 'rgba(248, 113, 113, 0.45)',
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
  timeframe: string;
  onPair: (pair: string) => void;
  onExchange: (exchange: string) => void;
  onTogglePause: () => void;
  onTimeframe: (tf: string) => void;
}

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function PairChart({
  label,
  pair,
  exchange,
  prices,
  pairs,
  exchanges,
  paused,
  timeframe,
  onPair,
  onExchange,
  onTogglePause,
  onTimeframe,
}: PairChartProps) {
  const chartEl = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  const [bars, setBars] = useState<RawBar[]>([]);
  const [feedStatus, setFeedStatus] = useState<'idle' | 'loading' | 'live' | 'error' | 'unsupported'>('idle');

  const matching = prices.filter((row) => row.pair === pair && (exchange ? row.exchange === exchange : true));
  const bestBid = matching.length ? Math.max(...matching.map((row) => row.bid)) : null;
  const bestAsk = matching.length ? Math.min(...matching.map((row) => row.ask)) : null;

  // Set up the chart once.
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

  // Fetch real OHLC from /api/candles. Refreshes every REFRESH_MS so the latest bar updates.
  useEffect(() => {
    if (!pair || !exchange) {
      setBars([]);
      setFeedStatus('idle');
      return;
    }
    if (!SUPPORTED_EXCHANGES.has(exchange)) {
      setBars([]);
      setFeedStatus('unsupported');
      return;
    }
    let cancelled = false;
    const load = async () => {
      setFeedStatus((s) => (s === 'live' ? 'live' : 'loading'));
      try {
        const url = `/api/candles?pair=${encodeURIComponent(pair)}&exchange=${encodeURIComponent(exchange)}&timeframe=${encodeURIComponent(timeframe)}&limit=120`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`http ${res.status}`);
        const body = (await res.json()) as { candles?: RawBar[] };
        if (cancelled) return;
        const next = Array.isArray(body.candles) ? body.candles : [];
        setBars(next);
        setFeedStatus(next.length ? 'live' : 'error');
      } catch {
        if (!cancelled) setFeedStatus('error');
      }
    };
    void load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pair, exchange, timeframe]);

  // Push bars to chart.
  useEffect(() => {
    candleSeriesRef.current?.setData(toCandleData(bars));
    volumeSeriesRef.current?.setData(toVolumeData(bars));
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  const statusDot =
    feedStatus === 'live' ? 'bg-emerald-400'
    : feedStatus === 'loading' ? 'bg-amber-400'
    : feedStatus === 'unsupported' ? 'bg-zinc-500'
    : feedStatus === 'error' ? 'bg-red-400'
    : 'bg-zinc-600';
  const statusLabel =
    feedStatus === 'live' ? 'live'
    : feedStatus === 'loading' ? 'loading'
    : feedStatus === 'unsupported' ? `${exchange} no OHLC`
    : feedStatus === 'error' ? 'feed err'
    : 'idle';

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-xs uppercase tracking-[0.2em] text-orange-400">{label}</span>
          <span className="text-sm font-semibold text-zinc-100">{pair}</span>
          <span className="text-xs text-zinc-500">@ {exchange ?? '—'}</span>
          <span className="ml-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
            <span className={`h-2 w-2 rounded-full ${statusDot}`} />
            {statusLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={timeframe}
            onChange={(e) => onTimeframe(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
          >
            {TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
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
