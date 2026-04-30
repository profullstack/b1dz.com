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
const FETCH_TIMEOUT_MS = 8000;

async function fetchJson<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(path, { cache: 'no-store', signal: controller.signal }).catch(() => null);
    if (!res?.ok) return null;
    const body = (await res.json().catch(() => null)) as { value?: unknown } | null;
    return (body?.value ?? null) as T | null;
  } finally {
    clearTimeout(timer);
  }
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
  // Preserve last-known-good values — a null/failed fetch should not blank the UI.
  const lastGood = useRef<Pick<SourceStateBundle, 'arb' | 'trade' | 'settings' | 'pipeline'>>({
    arb: null, trade: null, settings: null, pipeline: null,
  });

  useEffect(() => {
    cancelled.current = false;

    const load = async () => {
      // Fetch independently — one slow/failed endpoint doesn't block the rest.
      const [arb, trade, settings, pipeline] = await Promise.all([
        fetchJson<ArbState>('/api/storage/source-state/crypto-arb').catch(() => null),
        fetchJson<TradeState>('/api/storage/source-state/crypto-trade').catch(() => null),
        fetchJson<UiSettings>('/api/storage/source-state/crypto-ui-settings').catch(() => null),
        fetchJson<ArbPipelineState>('/api/storage/source-state/arb-pipeline').catch(() => null),
      ]);

      if (cancelled.current) return;

      // Only overwrite last-good when the endpoint actually returned data.
      if (arb !== null) lastGood.current.arb = arb;
      if (trade !== null) lastGood.current.trade = trade;
      if (settings !== null) lastGood.current.settings = settings;
      if (pipeline !== null) lastGood.current.pipeline = pipeline;

      const anyFresh = arb !== null || trade !== null;

      setBundle((prev) => ({
        arb: lastGood.current.arb,
        trade: lastGood.current.trade,
        settings: lastGood.current.settings,
        pipeline: lastGood.current.pipeline,
        loading: false,
        lastFetched: anyFresh ? Date.now() : prev.lastFetched,
        error: null,
      }));
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
