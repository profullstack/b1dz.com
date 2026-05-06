'use client';

/**
 * Realtime source-state hook — consumes the /api/stream SSE feed.
 *
 * Previously: four parallel setInterval(fetch, 3000) calls per component
 * mount, each opening a new TCP connection every 3 seconds.
 *
 * Now: ONE persistent EventSource per page. The server pushes named events
 * only when the underlying Redis data changes (delta detection), so silent
 * daemon ticks cost ~0 bytes on the wire. The browser's built-in
 * EventSource handles reconnects automatically with exponential backoff.
 *
 * Event→state mapping:
 *   state:arb      → arb
 *   state:trade    → trade
 *   state:pipeline → pipeline
 *   state:settings → settings
 *
 * The `ticker` event (live bid/ask prices) is consumed separately by the
 * chart — see useTickerStream().
 *
 * Exported API is identical to the old polling hook so every consumer
 * (ConsoleClient, DashboardSummary, StatusBar, etc.) requires zero changes.
 */

import { useEffect, useRef, useState } from 'react';
import type { ArbState, ArbPipelineState, PumpfunState, TradeState, UiSettings } from './source-state-types';

export interface SourceStateBundle {
  arb: ArbState | null;
  trade: TradeState | null;
  settings: UiSettings | null;
  pipeline: ArbPipelineState | null;
  pumpfun: PumpfunState | null;
  loading: boolean;
  lastFetched: number | null;
  error: string | null;
}

const LS_KEY = 'b1dz:source-state';

type LsData = {
  arb: ArbState | null;
  trade: TradeState | null;
  settings: UiSettings | null;
  pipeline: ArbPipelineState | null;
  pumpfun: PumpfunState | null;
  savedAt: number;
};

function readLs(): LsData | null {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as LsData) : null;
  } catch {
    return null;
  }
}

function writeLs(d: Omit<LsData, 'savedAt'>) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify({ ...d, savedAt: Date.now() }));
  } catch { /* quota / private mode */ }
}

function fromLs(): SourceStateBundle {
  if (typeof window === 'undefined') {
    return { arb: null, trade: null, settings: null, pipeline: null, pumpfun: null, loading: true, lastFetched: null, error: null };
  }
  const c = readLs();
  return {
    arb: c?.arb ?? null,
    trade: c?.trade ?? null,
    settings: c?.settings ?? null,
    pipeline: c?.pipeline ?? null,
    pumpfun: c?.pumpfun ?? null,
    loading: c === null,
    lastFetched: c?.savedAt ?? null,
    error: null,
  };
}

export function useSourceState(): SourceStateBundle {
  const [bundle, setBundle] = useState<SourceStateBundle>(fromLs);
  const stateRef = useRef<Omit<LsData, 'savedAt'>>({
    arb: null, trade: null, settings: null, pipeline: null, pumpfun: null,
  });

  useEffect(() => {
    const seed = readLs();
    stateRef.current = {
      arb: seed?.arb ?? null,
      trade: seed?.trade ?? null,
      settings: seed?.settings ?? null,
      pipeline: seed?.pipeline ?? null,
      pumpfun: seed?.pumpfun ?? null,
    };

    const patch = <K extends keyof typeof stateRef.current>(
      key: K,
      val: (typeof stateRef.current)[K],
    ) => {
      stateRef.current[key] = val;
      setBundle((prev) => ({
        ...prev,
        [key]: val,
        loading: false,
        lastFetched: Date.now(),
        error: null,
      }));
      writeLs(stateRef.current);
    };

    const es = new EventSource('/api/stream');

    es.addEventListener('state:arb', (e: MessageEvent) => {
      try { patch('arb', JSON.parse(e.data) as ArbState); } catch {}
    });
    es.addEventListener('state:trade', (e: MessageEvent) => {
      try { patch('trade', JSON.parse(e.data) as TradeState); } catch {}
    });
    es.addEventListener('state:pipeline', (e: MessageEvent) => {
      try { patch('pipeline', JSON.parse(e.data) as ArbPipelineState); } catch {}
    });
    es.addEventListener('state:pumpfun', (e: MessageEvent) => {
      try { patch('pumpfun', JSON.parse(e.data) as PumpfunState); } catch {}
    });
    es.addEventListener('state:settings', (e: MessageEvent) => {
      try { patch('settings', JSON.parse(e.data) as UiSettings); } catch {}
    });

    es.onerror = () => {
      setBundle((prev) => {
        if (prev.lastFetched !== null) return prev;
        return { ...prev, error: 'stream error — reconnecting' };
      });
    };

    return () => {
      es.close();
    };
  }, []);

  return bundle;
}

export async function putUiSettings(next: UiSettings): Promise<boolean> {
  const res = await fetch('/api/storage/source-state/crypto-ui-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next),
  }).catch(() => null);
  return !!res?.ok;
}

/**
 * A tick row from the `ticker` SSE event.
 * Used by PairChart to update the current candle in realtime.
 */
export interface TickerTick {
  pair: string;
  exchange: string;
  bid: number;
  ask: number;
  ts: number;
}

/**
 * Subscribe to the ticker stream for a specific pair+exchange.
 * Returns the latest bid/ask pushed ~every 500ms by the SSE route.
 * Replaces the PairChart 10-second /api/candles polling for live price.
 */
export function useTickerStream(pair: string | null, exchange: string | null): TickerTick | null {
  const [tick, setTick] = useState<TickerTick | null>(null);

  useEffect(() => {
    if (!pair || !exchange) {
      setTick(null);
      return;
    }
    const url = `/api/stream?ticker=${encodeURIComponent(`${pair}:${exchange}`)}`;
    const es = new EventSource(url);

    es.addEventListener('ticker', (e: MessageEvent) => {
      try {
        const ticks = JSON.parse(e.data) as TickerTick[];
        const match = ticks.find((t) => t.pair === pair && t.exchange === exchange);
        if (match) setTick(match);
      } catch {}
    });

    es.onerror = () => {};

    return () => {
      es.close();
    };
  }, [pair, exchange]);

  return tick;
}
