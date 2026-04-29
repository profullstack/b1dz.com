'use client';

import { useEffect, useRef, useState } from 'react';
import type { ArbState, ArbPipelineState, TradeState, UiSettings } from './source-state-types';

export interface SourceStateBundle {
  arb: ArbState | null;
  trade: TradeState | null;
  settings: UiSettings | null;
  pipeline: ArbPipelineState | null;
  loading: boolean;
  lastFetched: number | null;
  error: string | null;
}

const POLL_MS = 5000;

async function fetchJson<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { value?: unknown } | null;
  return (body?.value ?? null) as T | null;
}

export function useSourceState(): SourceStateBundle {
  const [bundle, setBundle] = useState<SourceStateBundle>({
    arb: null,
    trade: null,
    settings: null,
    pipeline: null,
    loading: true,
    lastFetched: null,
    error: null,
  });
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    const load = async () => {
      try {
        const [arb, trade, settings, pipeline] = await Promise.all([
          fetchJson<ArbState>('/api/storage/source-state/crypto-arb'),
          fetchJson<TradeState>('/api/storage/source-state/crypto-trade'),
          fetchJson<UiSettings>('/api/storage/source-state/crypto-ui-settings'),
          fetchJson<ArbPipelineState>('/api/storage/source-state/arb-pipeline'),
        ]);
        if (cancelled.current) return;
        setBundle({
          arb,
          trade,
          settings,
          pipeline,
          loading: false,
          lastFetched: Date.now(),
          error: null,
        });
      } catch (e) {
        if (cancelled.current) return;
        setBundle((prev) => ({ ...prev, loading: false, error: (e as Error).message }));
      }
    };
    void load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      cancelled.current = true;
      window.clearInterval(id);
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
