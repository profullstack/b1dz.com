'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PLUGIN_CATALOG } from '@b1dz/core';

interface InstalledRow {
  plugin_id: string;
  version: string;
  status: string;
  paid_until: string | null;
  installed_at: string;
}

export function PluginsSection() {
  const [rows, setRows] = useState<InstalledRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/store/installed', { cache: 'no-store' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body = (await res.json()) as { installed: InstalledRow[] };
      setRows(body.installed ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const uninstall = async (pluginId: string) => {
    setUninstalling(pluginId);
    try {
      const res = await fetch('/api/store/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginId }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`${res.status}: ${t.slice(0, 100)}`);
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUninstalling(null);
    }
  };

  const now = Date.now();

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Installed Plugins</h2>
            <p className="text-xs text-zinc-500 mt-1">Plugins enabled for your account. Free plugins are always active.</p>
          </div>
          <Link href="/store" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-orange-500 hover:text-orange-300 transition">
            Browse store →
          </Link>
        </div>

        {error && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300 mb-3">{error}</p>}
        {loading && <p className="text-sm text-zinc-500">loading…</p>}

        {!loading && rows.length === 0 && (
          <div className="rounded-lg border border-dashed border-zinc-700 py-8 text-center">
            <p className="text-sm text-zinc-500 mb-2">No plugins installed yet.</p>
            <Link href="/store" className="text-xs text-orange-400 hover:text-orange-300">Browse the store →</Link>
          </div>
        )}

        {rows.length > 0 && (
          <div className="divide-y divide-zinc-800">
            {rows.map((row) => {
              const entry = PLUGIN_CATALOG.find((e) => e.manifest.id === row.plugin_id);
              const name = entry?.manifest.name ?? row.plugin_id;
              const isFree = !row.paid_until;
              const expiresMs = row.paid_until ? new Date(row.paid_until).getTime() : null;
              const isActive = row.status === 'active' && (expiresMs == null || expiresMs > now);
              const isExpired = expiresMs != null && expiresMs <= now;
              const expiresLabel = expiresMs ? new Date(expiresMs).toLocaleDateString() : null;
              const installedLabel = new Date(row.installed_at).toLocaleDateString();

              return (
                <div key={row.plugin_id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100 truncate">{name}</span>
                      <span className="text-[10px] font-mono text-zinc-600">{row.version}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-[11px]">
                      <span className="text-zinc-500">installed {installedLabel}</span>
                      {isFree && <span className="text-emerald-400">free · never expires</span>}
                      {!isFree && isActive && expiresLabel && <span className="text-emerald-400">active until {expiresLabel}</span>}
                      {!isFree && isExpired && <span className="text-red-400">expired {expiresLabel}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {isExpired && (
                      <Link href={`/store`} className="text-xs text-amber-300 hover:text-amber-200">Renew →</Link>
                    )}
                    {isFree && (
                      <button
                        onClick={() => void uninstall(row.plugin_id)}
                        disabled={uninstalling === row.plugin_id}
                        className="text-xs text-zinc-600 hover:text-red-400 transition disabled:opacity-40"
                      >
                        {uninstalling === row.plugin_id ? 'removing…' : 'uninstall'}
                      </button>
                    )}
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                      isActive
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-red-500/30 bg-red-500/10 text-red-300'
                    }`}>
                      {isActive ? 'active' : 'expired'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
