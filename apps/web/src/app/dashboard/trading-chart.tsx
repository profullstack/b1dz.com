'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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

type PriceRow = {
  exchange: string;
  pair: string;
  bid: number;
  ask: number;
};

type SpreadRow = {
  pair?: string;
  buyExchange?: string;
  sellExchange?: string;
  spread?: number;
  spreadPct?: number;
  netPct?: number;
  grossPct?: number;
};

type SourceState = {
  prices?: PriceRow[];
  spreads?: SpreadRow[];
  daemon?: { lastTickAt?: string; status?: string };
};

const FALLBACK_PRICES: PriceRow[] = [
  { exchange: 'kraken', pair: 'BTC-USD', bid: 64280, ask: 64296 },
  { exchange: 'coinbase', pair: 'BTC-USD', bid: 64272, ask: 64291 },
  { exchange: 'binanceus', pair: 'BTC-USD', bid: 64288, ask: 64302 },
  { exchange: 'gemini', pair: 'BTC-USD', bid: 64261, ask: 64284 },
  { exchange: 'kraken', pair: 'ETH-USD', bid: 3185, ask: 3188 },
  { exchange: 'coinbase', pair: 'ETH-USD', bid: 3183, ask: 3187 },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function normalizePriceRow(value: unknown): PriceRow | null {
  if (!isRecord(value)) return null;
  const exchange = typeof value.exchange === 'string' ? value.exchange : null;
  const pair = typeof value.pair === 'string' ? value.pair : null;
  const bid = toNumber(value.bid);
  const ask = toNumber(value.ask);
  if (!exchange || !pair || bid == null || ask == null || bid <= 0 || ask <= 0) return null;
  return { exchange, pair, bid, ask };
}

function normalizeSpreadRow(value: unknown): SpreadRow | null {
  if (!isRecord(value)) return null;
  return {
    pair: typeof value.pair === 'string' ? value.pair : undefined,
    buyExchange: typeof value.buyExchange === 'string' ? value.buyExchange : undefined,
    sellExchange: typeof value.sellExchange === 'string' ? value.sellExchange : undefined,
    spread: toNumber(value.spread) ?? undefined,
    spreadPct: toNumber(value.spreadPct) ?? undefined,
    netPct: toNumber(value.netPct) ?? undefined,
    grossPct: toNumber(value.grossPct) ?? undefined,
  };
}

function normalizeSourceState(value: unknown): SourceState {
  if (!isRecord(value)) return {};
  const prices = Array.isArray(value.prices)
    ? value.prices.map(normalizePriceRow).filter((row): row is PriceRow => row !== null)
    : undefined;
  const spreads = Array.isArray(value.spreads)
    ? value.spreads.map(normalizeSpreadRow).filter((row): row is SpreadRow => row !== null)
    : undefined;
  const daemon = isRecord(value.daemon)
    ? {
        lastTickAt: typeof value.daemon.lastTickAt === 'string' ? value.daemon.lastTickAt : undefined,
        status: typeof value.daemon.status === 'string' ? value.daemon.status : undefined,
      }
    : undefined;
  return { prices, spreads, daemon };
}

interface RawBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const OHLC_EXCHANGES = new Set(['coinbase', 'kraken', 'binance-us', 'binanceus', 'gemini']);

function pickOhlcExchange(rows: PriceRow[], pair: string): string | null {
  const supported = rows.find((row) => row.pair === pair && OHLC_EXCHANGES.has(row.exchange));
  if (supported) return supported.exchange;
  return rows.find((row) => row.pair === pair)?.exchange ?? null;
}

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

function formatPct(value: number | undefined) {
  return value == null ? '—' : `${value.toFixed(3)}%`;
}

export function TradingChart() {
  const chartEl = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const [sourceState, setSourceState] = useState<SourceState>({ prices: FALLBACK_PRICES });
  const [selectedPair, setSelectedPair] = useState('BTC-USD');
  const [isLive, setIsLive] = useState(false);
  const [bars, setBars] = useState<RawBar[]>([]);
  const [feedStatus, setFeedStatus] = useState<'idle' | 'live' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch('/api/storage/source-state/crypto-arb', { cache: 'no-store' }).catch(() => null);
      if (!res?.ok) {
        if (!cancelled) setIsLive(false);
        return;
      }
      const body = (await res.json().catch(() => null)) as { value?: unknown } | null;
      const normalized = normalizeSourceState(body?.value);
      if (!cancelled && normalized.prices?.length) {
        setSourceState(normalized);
        setIsLive(true);
      }
    }
    void load();
    const id = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const prices = sourceState.prices?.length ? sourceState.prices : FALLBACK_PRICES;
  const pairs = useMemo(() => Array.from(new Set(prices.map((row) => row.pair))).sort(), [prices]);
  const selectedPrices = prices.filter((row) => row.pair === selectedPair);
  const topSpread = sourceState.spreads?.find((row) => row.pair === selectedPair) ?? null;
  const bestBid = selectedPrices.length ? Math.max(...selectedPrices.map((row) => row.bid)) : null;
  const bestAsk = selectedPrices.length ? Math.min(...selectedPrices.map((row) => row.ask)) : null;
  const ohlcExchange = useMemo(() => pickOhlcExchange(prices, selectedPair), [prices, selectedPair]);

  useEffect(() => {
    if (!pairs.includes(selectedPair) && pairs[0]) setSelectedPair(pairs[0]);
  }, [pairs, selectedPair]);

  // Fetch real OHLC for the selected pair from a supported exchange.
  useEffect(() => {
    if (!ohlcExchange) {
      setBars([]);
      setFeedStatus('idle');
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const url = `/api/candles?pair=${encodeURIComponent(selectedPair)}&exchange=${encodeURIComponent(ohlcExchange)}&timeframe=5m&limit=120`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('http');
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
    const id = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedPair, ohlcExchange]);

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
    candleSeriesRef.current?.setData(toCandleData(bars));
    volumeSeriesRef.current?.setData(toVolumeData(bars));
    chartRef.current?.timeScale().fitContent();
  }, [bars]);

  const liveLabel = feedStatus === 'live' ? `Live ${ohlcExchange ?? ''}`.trim() : isLive ? 'Daemon prices' : 'Demo data';
  const liveDot = feedStatus === 'live' ? 'bg-emerald-400' : isLive ? 'bg-amber-400' : 'bg-zinc-500';

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 shadow-2xl shadow-black/20">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-zinc-100">Live market chart</h2>
          <p className="mt-1 text-sm text-zinc-400">
            5-minute candles fetched from {ohlcExchange ?? 'an exchange'} every 10 seconds; bid/ask come from the daemon&apos;s live tick stream.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${liveDot}`} />
          <span className="text-xs uppercase tracking-wider text-zinc-400">{liveLabel}</span>
          <select
            value={selectedPair}
            onChange={(event) => setSelectedPair(event.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition hover:border-zinc-500"
          >
            {pairs.map((pair) => <option key={pair} value={pair}>{pair}</option>)}
          </select>
        </div>
      </div>

      <div className="grid gap-3 pb-4 sm:grid-cols-3">
        <Metric label="Best bid" value={bestBid == null ? '—' : `$${bestBid.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <Metric label="Best ask" value={bestAsk == null ? '—' : `$${bestAsk.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <Metric label="Top spread" value={formatPct(topSpread?.spreadPct ?? topSpread?.netPct ?? topSpread?.grossPct ?? topSpread?.spread)} />
      </div>

      <div ref={chartEl} className="h-[360px] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/80" />

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {selectedPrices.map((row) => (
          <div key={`${row.exchange}-${row.pair}`} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-sm">
            <div className="font-medium capitalize text-zinc-200">{row.exchange}</div>
            <div className="mt-1 text-zinc-500">Bid ${row.bid.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
            <div className="text-zinc-500">Ask ${row.ask.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
      <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}
