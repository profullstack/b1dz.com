'use client';

import { useState } from 'react';
import Link from 'next/link';

/**
 * Switch a saved/published strategy on or off for live trading
 * (POST/DELETE /api/strategies/:id/run). Shown in the builder and on
 * community store cards.
 */
export function RunStrategyButton({
  strategyId,
  initialRunning,
  onChange,
  compact = false,
}: {
  strategyId: string;
  initialRunning: boolean;
  onChange?: (running: boolean) => void;
  compact?: boolean;
}) {
  const [running, setRunning] = useState(initialRunning);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function toggle() {
    if (!running && !window.confirm(
      'Trade with this strategy? It replaces the built-in strategies for its asset class within a minute. '
      + 'Orders still respect your risk settings and live-execution switches.',
    )) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/strategies/${strategyId}/run`, { method: running ? 'DELETE' : 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `request failed (${res.status})`);
        return;
      }
      setRunning(json.running);
      onChange?.(json.running);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? 'flex flex-col items-end gap-1' : 'space-y-1'}>
      <button
        onClick={toggle}
        disabled={busy}
        className={
          running
            ? 'rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 transition'
            : 'rounded-lg border border-sky-500/40 px-4 py-2 text-sm text-sky-300 hover:bg-sky-500/10 disabled:opacity-50 transition'
        }
        title={running ? 'Stop trading with it' : 'Trade with it in your b1dz daemon'}
      >
        {busy ? '…' : running ? '● Running · Stop' : '▶ Run live'}
      </button>
      {running && !compact && (
        <p className="text-[11px] text-zinc-500">
          Live within a minute. Pause or remove it under{' '}
          <Link href="/settings" className="text-orange-400 hover:underline">Settings → Plugins</Link>.
        </p>
      )}
      {error && <p className="text-[11px] text-rose-300">{error}</p>}
    </div>
  );
}
