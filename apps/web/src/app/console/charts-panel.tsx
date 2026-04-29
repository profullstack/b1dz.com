'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ArbState } from '@/lib/source-state-types';
import { PairChart } from './pair-chart';

const CYCLE_MS = 30_000;

interface ChartsPanelProps {
  arb: ArbState | null;
}

export function ChartsPanel({ arb }: ChartsPanelProps) {
  const prices = arb?.prices ?? [];
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

  // Seed initial selection.
  useEffect(() => {
    if (!pairs.length) return;
    if (!pairA || !pairs.includes(pairA)) setPairA(pairs[0]);
    if (!pairB || !pairs.includes(pairB) || pairB === pairA) {
      const next = pairs.find((p) => p !== (pairA ?? pairs[0])) ?? pairs[0];
      setPairB(next);
    }
  }, [pairs, pairA, pairB]);

  // Default exchange = first exchange that quotes the chosen pair.
  useEffect(() => {
    if (!pairA || exchangeA) return;
    const found = prices.find((row) => row.pair === pairA);
    if (found) setExchangeA(found.exchange);
  }, [pairA, exchangeA, prices]);
  useEffect(() => {
    if (!pairB || exchangeB) return;
    const found = prices.find((row) => row.pair === pairB && row.exchange !== exchangeA)
      ?? prices.find((row) => row.pair === pairB);
    if (found) setExchangeB(found.exchange);
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

  // When pair changes via rotation or user, reset exchange to a sensible default for the new pair.
  useEffect(() => {
    if (!pairA) return;
    const stillValid = exchangeA && prices.some((row) => row.pair === pairA && row.exchange === exchangeA);
    if (stillValid) return;
    const found = prices.find((row) => row.pair === pairA);
    if (found) setExchangeA(found.exchange);
  }, [pairA, exchangeA, prices]);
  useEffect(() => {
    if (!pairB) return;
    const stillValid = exchangeB && prices.some((row) => row.pair === pairB && row.exchange === exchangeB);
    if (stillValid) return;
    const found = prices.find((row) => row.pair === pairB);
    if (found) setExchangeB(found.exchange);
  }, [pairB, exchangeB, prices]);

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
        onPair={(p) => { setPairA(p); setPausedA(true); }}
        onExchange={(x) => { setExchangeA(x); setPausedA(true); }}
        onTogglePause={() => setPausedA((v) => !v)}
      />
      <PairChart
        label="Chart B"
        pair={pairB}
        exchange={exchangeB}
        prices={prices}
        pairs={pairs}
        exchanges={exchanges}
        paused={pausedB}
        onPair={(p) => { setPairB(p); setPausedB(true); }}
        onExchange={(x) => { setExchangeB(x); setPausedB(true); }}
        onTogglePause={() => setPausedB((v) => !v)}
      />
    </div>
  );
}
