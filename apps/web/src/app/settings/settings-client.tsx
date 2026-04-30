'use client';

import { useEffect, useState } from 'react';
import { CexSection } from './sections/cex';
import { DexSection } from './sections/dex';
import { WalletsSection } from './sections/wallets';
import { RpcSection } from './sections/rpc';
import { ThresholdsSection } from './sections/thresholds';
import { TogglesSection } from './sections/toggles';
import type { SettingsResponse } from './shared';

type Tab = 'wallets' | 'cex' | 'dex' | 'rpc' | 'thresholds' | 'toggles';

const TABS: { id: Tab; label: string }[] = [
  { id: 'wallets', label: 'Wallets' },
  { id: 'cex', label: 'CEX keys' },
  { id: 'dex', label: 'DEX keys' },
  { id: 'rpc', label: 'RPC URLs' },
  { id: 'thresholds', label: 'Thresholds' },
  { id: 'toggles', label: 'Toggles' },
];

export function SettingsClient() {
  const [tab, setTab] = useState<Tab>('wallets');
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body = (await res.json()) as SettingsResponse;
      setData(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onSaved = (next: SettingsResponse) => setData(next);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-zinc-100">Account settings</h1>
        <p className="text-sm text-zinc-400">
          API keys and hot-wallet privkeys are AES-256-GCM encrypted with a service-side key before being written to the database. Plaintext fields (wallet addresses, thresholds, toggles) are stored as-is.
        </p>
        {data && data.cryptoConfigured === false && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Server-side encryption key (SETTINGS_ENCRYPTION_KEY) is not configured. Plaintext fields can be saved; secrets cannot.
          </p>
        )}
      </header>

      <div className="flex flex-wrap gap-1 border-b border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
              tab === t.id
                ? 'border-orange-500 text-orange-300'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && !data && <p className="text-sm text-zinc-500">loading…</p>}
      {error && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

      {data && (
        <div>
          {tab === 'wallets' && <WalletsSection data={data} onSaved={onSaved} />}
          {tab === 'cex' && <CexSection data={data} onSaved={onSaved} />}
          {tab === 'dex' && <DexSection data={data} onSaved={onSaved} />}
          {tab === 'rpc' && <RpcSection data={data} onSaved={onSaved} />}
          {tab === 'thresholds' && <ThresholdsSection data={data} onSaved={onSaved} />}
          {tab === 'toggles' && <TogglesSection data={data} onSaved={onSaved} />}
        </div>
      )}
    </div>
  );
}
