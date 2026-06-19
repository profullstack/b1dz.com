'use client';

import { useEffect, useState } from 'react';
import { NumberRow, SectionShell } from '../shared';
import { putUiSettings } from '@/lib/use-source-state';
import type { UiSettings } from '@/lib/source-state-types';

type Window = 'daily' | 'weekly' | 'monthly';

/**
 * Crypto spend budget — the rolling USD cap on BUYS that every order (engine,
 * AI analyzer, or external agent) is hard-capped against. Lives in
 * `crypto-ui-settings` alongside the daily-loss limit (read per-tick by the
 * daemon's crypto-trade worker — NOT operator env), so it stays per-user.
 *
 * The generic storage PUT replaces the whole row, so we fetch the current
 * settings first and merge our fields to avoid clobbering tradingEnabled /
 * dailyLossLimitPct.
 */
export function CryptoBudgetSection() {
  const [loaded, setLoaded] = useState<UiSettings | null>(null);
  const [budget, setBudget] = useState('');
  const [window, setWindow] = useState<Window>('daily');
  const [maxPos, setMaxPos] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/storage/source-state/crypto-ui-settings', { cache: 'no-store' }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as { value?: UiSettings } | null) : null;
      const cur = body?.value ?? {};
      setLoaded(cur);
      if (typeof cur.spendBudgetUsd === 'number') setBudget(String(cur.spendBudgetUsd));
      if (cur.budgetWindow === 'daily' || cur.budgetWindow === 'weekly' || cur.budgetWindow === 'monthly') setWindow(cur.budgetWindow);
      if (typeof cur.maxPositionUsd === 'number') setMaxPos(String(cur.maxPositionUsd));
    })();
  }, []);

  const num = (s: string) => (s.trim() === '' ? null : Number(s));

  const onSave = async () => {
    setStatus(null);
    // Re-fetch immediately before writing to minimize clobbering a concurrent
    // toggle change (the storage row is shared with tradingEnabled etc.).
    const res = await fetch('/api/storage/source-state/crypto-ui-settings', { cache: 'no-store' }).catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as { value?: UiSettings } | null) : null;
    const cur = body?.value ?? loaded ?? {};
    const ok = await putUiSettings({
      ...cur,
      spendBudgetUsd: num(budget),
      budgetWindow: window,
      maxPositionUsd: num(maxPos),
    });
    setStatus(ok ? 'Saved.' : 'Save failed — try again.');
  };

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
        The spend budget is the master cap on crypto <span className="text-emerald-300">buys</span>. Every order — from the
        deterministic engine, the AI analyzer, or a connected agent — is hard-capped against it. Leave the budget blank for no
        cap (the per-position size still applies).
      </p>

      <SectionShell
        title="Crypto spend budget"
        description="A rolling USD limit on buys, summed from the durable spend ledger so it survives restarts and is shared across the engine and agents."
        onSave={onSave}
      >
        <NumberRow field="spendBudgetUsd" label="Spend budget (USD)" value={budget} onChange={setBudget} hint="Total USD of buys allowed per window. Blank = unlimited." />
        <div className="flex items-center justify-between gap-3 py-2">
          <label className="text-sm text-zinc-300">Budget window</label>
          <select
            value={window}
            onChange={(e) => setWindow(e.target.value as Window)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
          >
            <option value="daily">Daily (UTC)</option>
            <option value="weekly">Weekly (from Monday UTC)</option>
            <option value="monthly">Monthly (from the 1st UTC)</option>
          </select>
        </div>
        <NumberRow field="maxPositionUsd" label="Max position per exchange (USD)" value={maxPos} onChange={setMaxPos} hint="Per-position cap. Blank = engine default ($100)." />
      </SectionShell>

      {status && <p className="text-xs text-zinc-400">{status}</p>}
    </div>
  );
}
