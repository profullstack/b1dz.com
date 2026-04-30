'use client';

import { useEffect, useState } from 'react';
import { CexSection } from './sections/cex';
import { DexSection } from './sections/dex';
import { WalletsSection } from './sections/wallets';
import { RpcSection } from './sections/rpc';
import { ThresholdsSection } from './sections/thresholds';
import { TogglesSection } from './sections/toggles';
import { PluginsSection } from './sections/plugins';
import { StrategiesSection } from './sections/strategies';
import type { SettingsResponse } from './shared';
import { importKey } from '@/lib/browser-crypto';

type Tab = 'plugins' | 'wallets' | 'cex' | 'dex' | 'rpc' | 'strategies' | 'thresholds' | 'toggles';

const TABS: { id: Tab; label: string }[] = [
  { id: 'plugins', label: 'Plugins' },
  { id: 'wallets', label: 'Wallets' },
  { id: 'cex', label: 'CEX keys' },
  { id: 'dex', label: 'DEX keys' },
  { id: 'rpc', label: 'RPC URLs' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'thresholds', label: 'Thresholds' },
  { id: 'toggles', label: 'Toggles' },
];

export function SettingsClient() {
  const [tab, setTab] = useState<Tab>('plugins');
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [cryptoKey, setCryptoKey] = useState<CryptoKey | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
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

  const loadKey = async () => {
    setKeyError(null);
    try {
      const res = await fetch('/api/settings/crypto-key', { cache: 'no-store' });
      if (res.status === 503) {
        setKeyError('SETTINGS_ENCRYPTION_KEY is not configured on the server.');
        return;
      }
      if (!res.ok) throw new Error(`crypto-key http ${res.status}`);
      const { key } = (await res.json()) as { key: string };
      const imported = await importKey(key);
      setCryptoKey(imported);
    } catch (e) {
      setKeyError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    void loadKey();
  }, []);

  const onSaved = (next: SettingsResponse) => setData(next);

  const cryptoUnavailable = !cryptoKey || (data && data.cryptoConfigured === false);

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-zinc-100">Account settings</h1>
        <p className="text-sm text-zinc-400">
          Secrets are encrypted in your browser with AES-256-GCM before being sent to the server. The server stores ciphertext only — plaintext never leaves your device. Click <span className="text-zinc-300">reveal</span> on any saved secret to decrypt it locally.
        </p>
        {data && data.cryptoConfigured === false && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Server-side encryption key (SETTINGS_ENCRYPTION_KEY) is not configured. Plaintext fields can be saved; secrets cannot.
          </p>
        )}
        {keyError && data?.cryptoConfigured !== false && (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            Could not load encryption key: {keyError}
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

      {tab === 'plugins' && <PluginsSection data={data} cryptoKey={cryptoKey} onSaved={onSaved} />}

      {data && tab !== 'plugins' && (
        <div>
          {tab === 'wallets' && <WalletsSection data={data} cryptoKey={cryptoKey} onSaved={onSaved} />}
          {tab === 'cex' && <CexSection data={data} cryptoKey={cryptoKey} cryptoUnavailable={!!cryptoUnavailable} onSaved={onSaved} />}
          {tab === 'dex' && <DexSection data={data} cryptoKey={cryptoKey} cryptoUnavailable={!!cryptoUnavailable} onSaved={onSaved} />}
          {tab === 'rpc' && <RpcSection data={data} cryptoKey={cryptoKey} onSaved={onSaved} />}
          {tab === 'strategies' && <StrategiesSection data={data} cryptoKey={cryptoKey} onSaved={onSaved} />}
          {tab === 'thresholds' && <ThresholdsSection data={data} cryptoKey={cryptoKey} onSaved={onSaved} />}
          {tab === 'toggles' && <TogglesSection data={data} cryptoKey={cryptoKey} onSaved={onSaved} />}
        </div>
      )}
    </div>
  );
}
