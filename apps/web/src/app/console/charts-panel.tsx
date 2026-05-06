'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArbState, TradeState } from '@/lib/source-state-types';
import { PairChart, type TradeMarkerInput } from './pair-chart';
import { useChartPin } from '@/lib/chart-pinner';

const CYCLE_MS = 30_000;

const OHLC_EXCHANGES = new Set(['coinbase', 'kraken', 'binance-us', 'binanceus', 'gemini']);

interface ChartsPanelProps {
  arb: ArbState | null;
  trade: TradeState | null;
}

function parseElapsedMs(elapsed: string): number {
  // "5m32s", "1h12m", "42s" — best-effort parse used by the TUI too.
  const matches = elapsed.matchAll(/(\d+)([hms])/g);
  let ms = 0;
  for (const m of matches) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    if (m[2] === 'h') ms += n * 3_600_000;
    else if (m[2] === 'm') ms += n * 60_000;
    else if (m[2] === 's') ms += n * 1_000;
  }
  return ms;
}

export function ChartsPanel({ arb, trade }: ChartsPanelProps) {
  const prices = arb?.prices ?? [];
  const closedTrades = trade?.tradeState?.closedTrades ?? [];
  const livePositions = trade?.tradeStatus?.positions
    ?? (trade?.tradeStatus?.position ? [{ exchange: 'kraken', ...trade.tradeStatus.position }] : []);

  const markersFor = (pair: string | null, exchange: string | null): TradeMarkerInput[] => {
    if (!pair || !exchange) return [];
    const out: TradeMarkerInput[] = [];
    for (const t of closedTrades) {
      if (t.pair !== pair || t.exchange !== exchange) continue;
      out.push({ kind: 'entry', time: t.entryTime, price: t.entryPrice });
      out.push({ kind: 'exit',  time: t.exitTime,  price: t.exitPrice, netPnl: t.netPnl });
    }
    for (const p of livePositions) {
      if (p.pair !== pair || p.exchange !== exchange) continue;
      const ageMs = parseElapsedMs(p.elapsed);
      out.push({ kind: 'open', time: Date.now() - ageMs, price: p.entryPrice });
    }
    return out;
  };
  const pairs = useMemo(
    () => Array.from(new Set(prices.map((row) => row.pair))).sort(),
    [prices],
  );
  const exchanges = useMemo(
    () => Array.from(new Set(prices.map((row) => row.exchange))).sort(),
    [prices],
  );

  const [pairA, setPairA] = useState<string | null>(null);
  const [pairB, setPairB] = useState<string | null>(null);
  const [exchangeA, setExchangeA] = useState<string | null>(null);
  const [exchangeB, setExchangeB] = useState<string | null>(null);
  const [pausedA, setPausedA] = useState(false);
  const [pausedB, setPausedB] = useState(false);
  const [timeframeA, setTimeframeA] = useState('1m');
  const [timeframeB, setTimeframeB] = useState('1m');

  // Honor external pins from clickable cells elsewhere on the page.
  // Each pin event flips which chart slot is updated and pauses auto-cycle
  // for that slot (manual control wins).
  const pin = useChartPin();
  const lastSeqRef = useRef(0);
  useEffect(() => {
    if (pin.pinSeq === 0 || pin.pinSeq === lastSeqRef.current) return;
    lastSeqRef.current = pin.pinSeq;
    if (pin.pairA) {
      setPairA(pin.pairA);
      if (pin.exchangeA) setExchangeA(pin.exchangeA);
      setPausedA(true);
    }
    if (pin.pairB) {
      setPairB(pin.pairB);
      if (pin.exchangeB) setExchangeB(pin.exchangeB);
      setPausedB(true);
    }
  }, [pin]);

  const pickExchange = (pair: string, avoidExchange: string | null = null): string | null => {
    const supported = prices.find(
      (row) => row.pair === pair && OHLC_EXCHANGES.has(row.exchange) && row.exchange !== avoidExchange,
    );
    if (supported) return supported.exchange;
    const anySupported = prices.find((row) => row.pair === pair && OHLC_EXCHANGES.has(row.exchange));
    if (anySupported) return anySupported.exchange;
    const any = prices.find((row) => row.pair === pair);
    return any?.exchange ?? null;
  };

  // Seed initial selection.
  useEffect(() => {
    if (!pairs.length) return;
    if (!pairA || !pairs.includes(pairA)) setPairA(pairs[0]);
    if (!pairB || !pairs.includes(pairB) || pairB === pairA) {
      const next = pairs.find((p) => p !== (pairA ?? pairs[0])) ?? pairs[0];
      setPairB(next);
    }
  }, [pairs, pairA, pairB]);

  // Default / repair exchange selection — prefer supported OHLC venues.
  useEffect(() => {
    if (!pairA) return;
    const stillValid = exchangeA && prices.some((row) => row.pair === pairA && row.exchange === exchangeA);
    if (stillValid) return;
    const next = pickExchange(pairA);
    if (next) setExchangeA(next);
  }, [pairA, exchangeA, prices]);
  useEffect(() => {
    if (!pairB) return;
    const stillValid = exchangeB && prices.some((row) => row.pair === pairB && row.exchange === exchangeB);
    if (stillValid) return;
    const next = pickExchange(pairB, exchangeA);
    if (next) setExchangeB(next);
  }, [pairB, exchangeB, exchangeA, prices]);

  // Auto-cycle every CYCLE_MS, skipping paused panes and avoiding duplicate pair on both panes.
  useEffect(() => {
    if (pairs.length < 2) return;
    const id = window.setInterval(() => {
      if (!pausedA) {
        setPairA((prev) => {
          if (!prev) return pairs[0];
          const idx = pairs.indexOf(prev);
          for (let i = 1; i <= pairs.length; i++) {
            const next = pairs[(idx + i) % pairs.length];
            if (next !== pairB) return next;
          }
          return prev;
        });
      }
      if (!pausedB) {
        setPairB((prev) => {
          if (!prev) return pairs[1] ?? pairs[0];
          const idx = pairs.indexOf(prev);
          for (let i = 1; i <= pairs.length; i++) {
            const next = pairs[(idx + i) % pairs.length];
            if (next !== pairA) return next;
          }
          return prev;
        });
      }
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [pairs, pausedA, pausedB, pairA, pairB]);

  if (!pairs.length || !pairA || !pairB) {
    return (
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 text-sm text-zinc-500">
        Waiting for daemon prices…
      </section>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PairChart
        label="Chart A"
        pair={pairA}
        exchange={exchangeA}
        prices={prices}
        pairs={pairs}
        exchanges={exchanges}
        paused={pausedA}
        timeframe={timeframeA}
        markers={markersFor(pairA, exchangeA)}
        onPair={(p) => { setPairA(p); setPausedA(true); }}
        onExchange={(x) => { setExchangeA(x); setPausedA(true); }}
        onTogglePause={() => setPausedA((v) => !v)}
        onTimeframe={setTimeframeA}
      />
      <PairChart
        label="Chart B"
        pair={pairB}
        exchange={exchangeB}
        prices={prices}
        pairs={pairs}
        exchanges={exchanges}
        paused={pausedB}
        timeframe={timeframeB}
        markers={markersFor(pairB, exchangeB)}
        onPair={(p) => { setPairB(p); setPausedB(true); }}
        onExchange={(x) => { setExchangeB(x); setPausedB(true); }}
        onTogglePause={() => setPausedB((v) => !v)}
        onTimeframe={setTimeframeB}
      />
    </div>
  );
}
