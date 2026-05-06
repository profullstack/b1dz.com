'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ArbState } from '@/lib/source-state-types';
import { useTickerStream } from '@/lib/use-source-state';

type PriceRow = NonNullable<ArbState['prices']>[number];

interface RawBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

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

export interface TradeMarkerInput {
  kind: 'entry' | 'exit' | 'open';
  time: number; // ms
  price: number;
  netPnl?: number;
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
  markers?: TradeMarkerInput[];
  onPair: (pair: string) => void;
  onExchange: (exchange: string) => void;
  onTogglePause: () => void;
  onTimeframe: (tf: string) => void;
}

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

const TIMEFRAME_TO_SEC: Record<string, number> = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
};

export function PairChart({
  label,
  pair,
  exchange,
  prices,
  pairs,
  exchanges,
  paused,
  timeframe,
  markers = [],
  onPair,
  onExchange,
  onTogglePause,
  onTimeframe,
}: PairChartProps) {
  const chartEl = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  // ISeriesMarkersPluginApi uses the generic Time type internally; the cast
  // to UTCTimestamp is safe because we only supply UTCTimestamp values.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<any> | null>(null);

  const [bars, setBars] = useState<RawBar[]>([]);
  const [feedStatus, setFeedStatus] = useState<'idle' | 'loading' | 'live' | 'error' | 'unsupported'>('idle');

  // SSE ticker — sub-second bid/ask updates from the daemon price cache.
  const tick = useTickerStream(pair, exchange);
  const matching = prices.filter((row) => row.pair === pair && (exchange ? row.exchange === exchange : true));
  const bestBid = tick?.bid ?? (matching.length ? Math.max(...matching.map((row) => row.bid)) : null);
  const bestAsk = tick?.ask ?? (matching.length ? Math.min(...matching.map((row) => row.ask)) : null);

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
    markersPluginRef.current = createSeriesMarkers(candleSeries, []);
    const resize = new ResizeObserver(() => chart.timeScale().fitContent());
    resize.observe(chartEl.current);
    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      markersPluginRef.current = null;
    };
  }, []);

  // Fetch historical OHLC once on mount (or when pair/exchange/timeframe changes).
  // Current candle is updated from SSE ticks below — no polling needed.
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
      setFeedStatus('loading');
      try {
        const url = `/api/candles?pair=${encodeURIComponent(pair)}&exchange=${encodeURIComponent(exchange)}&timeframe=${encodeURIComponent(timeframe)}&limit=500`;
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
    return () => { cancelled = true; };
  }, [pair, exchange, timeframe]);

  // Update the current (rightmost) candle's close from SSE ticks — gives
  // realtime price movement without re-fetching the full bar history.
  useEffect(() => {
    if (!tick || !candleSeriesRef.current || bars.length === 0) return;
    const mid = (tick.bid + tick.ask) / 2;
    const lastBar = bars[bars.length - 1];
    if (!lastBar) return;
    const updatedBar: CandlestickData<UTCTimestamp> = {
      time: Math.floor(lastBar.time / 1000) as UTCTimestamp,
      open: lastBar.open,
      high: Math.max(lastBar.high, mid),
      low: Math.min(lastBar.low, mid),
      close: mid,
    };
    try {
      candleSeriesRef.current.update(updatedBar);
      setFeedStatus('live');
    } catch {
      // Chart removed during pair/exchange transition — safe to ignore.
    }
  }, [tick, bars]);

  // Push bars to chart. We load enough history (500 bars) so historical
  // trade markers fall inside the loaded window, but default the visible
  // range to the most recent ~120 bars so candles aren't squished.
  // The user can pan/zoom out to see older markers.
  useEffect(() => {
    candleSeriesRef.current?.setData(toCandleData(bars));
    volumeSeriesRef.current?.setData(toVolumeData(bars));
    if (bars.length > 0) {
      const visibleCount = Math.min(120, bars.length);
      const from = bars.length - visibleCount;
      const to = bars.length - 1;
      chartRef.current?.timeScale().setVisibleLogicalRange({ from, to });
    }
  }, [bars]);

  // Project entry/exit/open markers onto the chart. Buys render as a
  // white up-triangle below the bar; sells as a white down-triangle
  // above. Open positions get a labelled up-triangle. Marker times are
  // bucketed to the timeframe boundary and matched against the loaded
  // bar set — same approach the TUI uses (markerRenderer.js). A
  // previous version clamped the time into [firstSec, lastSec], which
  // pinned every recent trade onto the most recent candle.
  useEffect(() => {
    const plugin = markersPluginRef.current;
    if (!plugin) return;
    if (!bars.length || !markers.length) {
      plugin.setMarkers([]);
      return;
    }
    const tfSec = TIMEFRAME_TO_SEC[timeframe] ?? 60;
    const barTimes = new Set<number>();
    for (const b of bars) barTimes.add(Math.floor(b.time / 1000));

    const seriesMarkers: SeriesMarker<UTCTimestamp>[] = [];
    for (const m of markers) {
      const bucketSec = Math.floor(Math.floor(m.time / 1000) / tfSec) * tfSec;
      if (!barTimes.has(bucketSec)) continue;
      const t = bucketSec as UTCTimestamp;
      if (m.kind === 'entry') {
        seriesMarkers.push({ time: t, position: 'belowBar', color: '#ffffff', shape: 'arrowUp', text: 'BUY' });
      } else if (m.kind === 'exit') {
        const profitable = (m.netPnl ?? 0) >= 0;
        seriesMarkers.push({
          time: t,
          position: 'aboveBar',
          color: '#ffffff',
          shape: 'arrowDown',
          text: profitable ? `SELL +$${m.netPnl?.toFixed(2)}` : `SELL ${m.netPnl?.toFixed(2)}`,
        });
      } else {
        seriesMarkers.push({ time: t, position: 'belowBar', color: '#fbbf24', shape: 'arrowUp', text: 'OPEN' });
      }
    }
    seriesMarkers.sort((a, b) => (a.time as number) - (b.time as number));
    plugin.setMarkers(seriesMarkers);
  }, [markers, bars, timeframe]);

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
