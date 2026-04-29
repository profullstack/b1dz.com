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

function mid(row: PriceRow) {
  return (row.bid + row.ask) / 2;
}

function buildCandles(rows: PriceRow[], pair: string): CandlestickData<UTCTimestamp>[] {
  const pairRows = rows.filter((row) => row.pair === pair);
  const base = pairRows.length
    ? pairRows.reduce((sum, row) => sum + mid(row), 0) / pairRows.length
    : mid(rows[0] ?? FALLBACK_PRICES[0]);
  const now = Math.floor(Date.now() / 1000);
  const start = now - 95 * 300;

  return Array.from({ length: 96 }, (_, i) => {
    const wave = Math.sin(i / 6) * base * 0.0025;
    const drift = (i - 48) * base * 0.000015;
    const open = base + wave + drift;
    const close = base + Math.sin((i + 1) / 6) * base * 0.0025 + drift + Math.cos(i / 4) * base * 0.0007;
    const high = Math.max(open, close) + base * (0.0008 + (i % 5) * 0.00008);
    const low = Math.min(open, close) - base * (0.0008 + (i % 7) * 0.00006);
    return {
      time: (start + i * 300) as UTCTimestamp,
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
  const candles = useMemo(() => buildCandles(prices, selectedPair), [prices, selectedPair]);

  useEffect(() => {
    if (!pairs.includes(selectedPair) && pairs[0]) setSelectedPair(pairs[0]);
  }, [pairs, selectedPair]);

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
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 shadow-2xl shadow-black/20">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-zinc-100">Live market chart</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Candles render from daemon source-state when available, with a demo fallback when the trading daemon is offline.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${isLive ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <span className="text-xs uppercase tracking-wider text-zinc-400">{isLive ? 'Live daemon' : 'Demo data'}</span>
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
