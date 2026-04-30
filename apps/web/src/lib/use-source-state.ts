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

const POLL_MS = 3000;
const FETCH_TIMEOUT_MS = 8000;
const LS_KEY = 'b1dz:source-state';

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

type LsData = {
  arb: ArbState | null;
  trade: TradeState | null;
  settings: UiSettings | null;
  pipeline: ArbPipelineState | null;
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
    return { arb: null, trade: null, settings: null, pipeline: null, loading: true, lastFetched: null, error: null };
  }
  const c = readLs();
  return {
    arb: c?.arb ?? null,
    trade: c?.trade ?? null,
    settings: c?.settings ?? null,
    pipeline: c?.pipeline ?? null,
    loading: c === null, // already have data → skip loading spinner
    lastFetched: c?.savedAt ?? null,
    error: null,
  };
}

export function useSourceState(): SourceStateBundle {
  const [bundle, setBundle] = useState<SourceStateBundle>(fromLs);
  const cancelled = useRef(false);
  const lastGood = useRef<Omit<LsData, 'savedAt'>>({ arb: null, trade: null, settings: null, pipeline: null });

  useEffect(() => {
    cancelled.current = false;

    // Seed lastGood from cache so partial-failure saves don't wipe keys we haven't re-fetched yet
    const seed = typeof window !== 'undefined' ? readLs() : null;
    lastGood.current = {
      arb: seed?.arb ?? null,
      trade: seed?.trade ?? null,
      settings: seed?.settings ?? null,
      pipeline: seed?.pipeline ?? null,
    };

    // Called as each individual fetch resolves — updates state immediately, not waiting for siblings
    const patch = <K extends keyof typeof lastGood.current>(
      key: K,
      val: (typeof lastGood.current)[K] | null,
    ) => {
      if (cancelled.current) return;
      if (val !== null) lastGood.current[key] = val;
      setBundle((prev) => ({
        ...prev,
        [key]: val !== null ? val : prev[key],
        loading: false,
        ...(val !== null && { lastFetched: Date.now() }),
      }));
    };

    const load = async () => {
      await Promise.all([
        fetchJson<ArbState>('/api/storage/source-state/crypto-arb')
          .then((v) => patch('arb', v)).catch(() => patch('arb', null)),
        fetchJson<TradeState>('/api/storage/source-state/crypto-trade')
          .then((v) => patch('trade', v)).catch(() => patch('trade', null)),
        fetchJson<UiSettings>('/api/storage/source-state/crypto-ui-settings')
          .then((v) => patch('settings', v)).catch(() => patch('settings', null)),
        fetchJson<ArbPipelineState>('/api/storage/source-state/arb-pipeline')
          .then((v) => patch('pipeline', v)).catch(() => patch('pipeline', null)),
      ]);
      writeLs(lastGood.current);
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
