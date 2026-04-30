'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { PLUGIN_CATALOG } from '@b1dz/core/catalog';
import {
  PlainTextRow,
  NumberRow,
  BoolRow,
  SecretRow,
  SectionShell,
  decryptSecretBlob,
  readPlainString,
  readPlainBool,
  saveSettings,
  type SettingsResponse,
} from '../shared';

// ── Per-plugin field spec ────────────────────────────────────────────────────

interface FieldDef { key: string; label: string; hint?: string; multiline?: boolean }
interface PluginFieldSpec {
  secrets?: FieldDef[];
  strings?: FieldDef[];
  numbers?: FieldDef[];
  bools?: FieldDef[];
}

const PLUGIN_FIELDS: Record<string, PluginFieldSpec> = {
  coinbase: {
    strings: [{ key: 'COINBASE_API_KEY_NAME', label: 'API key name', hint: 'organizations/.../apiKeys/...' }],
    secrets: [
      { key: 'COINBASE_API_PRIVATE_KEY', label: 'EC private key (PEM)', multiline: true, hint: '-----BEGIN EC PRIVATE KEY----- block' },
      { key: 'COINBASE_API_PRIVATE_KEY_B', label: 'EC private key B (PEM, optional)', multiline: true, hint: 'Second account key' },
      { key: 'COINBASE_EC_KEY_B', label: 'EC key B legacy (PEM, optional)', multiline: true, hint: 'Legacy secondary key' },
    ],
  },
  kraken: {
    secrets: [
      { key: 'KRAKEN_API_KEY', label: 'API key' },
      { key: 'KRAKEN_API_SECRET', label: 'API secret' },
    ],
  },
  'binance-us': {
    secrets: [
      { key: 'BINANCE_US_API_KEY', label: 'API key' },
      { key: 'BINANCE_US_API_SECRET', label: 'API secret' },
    ],
  },
  gemini: {
    strings: [{ key: 'GEMINI_ACCOUNT', label: 'Account name', hint: 'primary / master / sub-label' }],
    secrets: [
      { key: 'GEMINI_API_KEY', label: 'API key' },
      { key: 'GEMINI_API_SECRET', label: 'API secret' },
    ],
  },
  'uniswap-v3-base': {
    secrets: [{ key: 'EVM_PRIVATE_KEY', label: 'EVM hot wallet private key', hint: '0x… 64-hex' }],
    strings: [{ key: 'BASE_RPC_URL', label: 'Base RPC URL' }],
    numbers: [
      { key: 'DEX_TRADE_MAX_USD', label: 'Max trade USD', hint: 'Hard ceiling per swap, e.g. 20' },
      { key: 'DEX_SLIPPAGE_BPS', label: 'Slippage (bps)', hint: '300 = 3%' },
    ],
  },
  '1inch': {
    secrets: [
      { key: 'ONEINCH_API_KEY', label: '1inch API key' },
      { key: 'EVM_PRIVATE_KEY', label: 'EVM hot wallet private key', hint: '0x… 64-hex' },
    ],
  },
  jupiter: {
    secrets: [{ key: 'SOLANA_PRIVATE_KEY', label: 'Solana hot wallet private key', hint: 'base58 secret key (88 chars)' }],
    strings: [{ key: 'SOLANA_RPC_URL', label: 'Solana RPC URL' }],
  },
  pumpfun: {
    secrets: [{ key: 'SOLANA_PRIVATE_KEY', label: 'Solana hot wallet private key', hint: 'base58 secret key (88 chars)' }],
    bools: [{ key: 'PUMPFUN_ENABLE_SCRAPE', label: 'Enable scraper' }],
  },
  '0x': {
    secrets: [{ key: 'ZEROX_API_KEY', label: '0x API key' }],
  },
  'cex-arb': {
    strings: [{ key: 'ARB_MODE', label: 'Mode', hint: 'observe | paper | live' }],
    numbers: [
      { key: 'ARB_MAX_TRADE_USD', label: 'Max trade USD', hint: 'Per-leg cap, e.g. 15' },
      { key: 'ARB_SIZE_USD', label: 'Notional size USD' },
      { key: 'ARB_MIN_NET_USD', label: 'Min net profit USD', hint: 'e.g. 0.01' },
      { key: 'ARB_MIN_NET_BPS', label: 'Min net profit bps', hint: 'e.g. 3 (= 0.03%)' },
    ],
    bools: [
      { key: 'ARB_EXECUTOR_UNISWAP_BASE', label: 'Arm Uniswap V3 executor' },
      { key: 'ARB_TRIANGULAR', label: 'Triangular arb scanner' },
      { key: 'MARGIN_TRADING', label: 'Margin trading' },
    ],
  },
  dca: {
    bools: [{ key: 'DCA_ENABLED', label: 'DCA enabled' }],
    strings: [
      { key: 'DCA_COINS', label: 'Coins', hint: 'BTC,ETH,SOL' },
      { key: 'DCA_EXCHANGES', label: 'Exchanges', hint: 'kraken,coinbase,binance-us,gemini' },
    ],
    numbers: [
      { key: 'DCA_TOTAL_ALLOCATION_PCT', label: 'Allocation %', hint: '% of equity, e.g. 10' },
      { key: 'DCA_MAX_COINS', label: 'Max coins', hint: 'e.g. 3' },
      { key: 'DCA_INTERVAL_MS', label: 'Interval ms', hint: '86400000 = 24h' },
    ],
  },
  'v2-pipeline': {
    strings: [{ key: 'V2_MODE', label: 'Mode', hint: 'observe | paper | live' }],
    numbers: [
      { key: 'V2_SIZE_USD', label: 'Notional size USD' },
      { key: 'V2_MAX_PAIRS', label: 'Max pairs', hint: 'e.g. 10' },
      { key: 'V2_MAX_TRADE_USD', label: 'Max trade USD' },
      { key: 'V2_MIN_NET_USD', label: 'Min net profit USD', hint: 'e.g. 0.10' },
    ],
  },
  'signal-trade': {
    numbers: [
      { key: 'ENTRY_MIN_SCORE', label: 'Min entry score', hint: '0–1, e.g. 0.6' },
      { key: 'MIN_HOLD_SECS', label: 'Min hold (secs)', hint: 'e.g. 300' },
      { key: 'MIN_VOLUME_USD', label: 'Min volume USD', hint: 'Pair must clear this threshold' },
    ],
    bools: [{ key: 'REQUIRE_CONFIRM_UPTREND', label: 'Require uptrend confirmation' }],
  },
  momentum: {
    numbers: [
      { key: 'ENTRY_MIN_SCORE', label: 'Min entry score', hint: '0–1' },
      { key: 'MIN_HOLD_SECS', label: 'Min hold (secs)' },
    ],
    bools: [{ key: 'REQUIRE_CONFIRM_UPTREND', label: 'Require uptrend confirmation' }],
  },
};

const SYSTEM_BOOLS: { key: string; label: string }[] = [
  { key: 'TRADING_ENABLED', label: 'Trading enabled (master on/off)' },
  { key: 'DEX_TRADE_EXECUTION', label: 'DEX trade execution (live signing)' },
  { key: 'ENABLE_PROXY', label: 'Enable HTTP proxy' },
];

// ── Types ────────────────────────────────────────────────────────────────────

interface InstalledRow {
  plugin_id: string;
  version: string;
  status: string;
  paid_until: string | null;
  installed_at: string;
}

// ── Main component ───────────────────────────────────────────────────────────

export function PluginsSection({
  data,
  cryptoKey,
  onSaved,
}: {
  data: SettingsResponse | null;
  cryptoKey: CryptoKey | null;
  onSaved: (next: SettingsResponse) => void;
}) {
  const [rows, setRows] = useState<InstalledRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{ pluginId: string; name: string } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (confirmTarget) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [confirmTarget]);

  // Shared secret state across all plugin panels
  const [decrypted, setDecrypted] = useState<Record<string, string> | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [pendingClear, setPendingClear] = useState<Record<string, true>>({});
  const [revealed, setRevealed] = useState<Record<string, true>>({});
  const [plainDrafts, setPlainDrafts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const cryptoUnavailable = !cryptoKey || (data && data.cryptoConfigured === false);

  // Decrypt the secret blob once key + cipher are available
  useEffect(() => {
    if (!data?.cipher || !cryptoKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const plain = await decryptSecretBlob(cryptoKey, data.cipher);
        if (!cancelled) setDecrypted(plain);
      } catch {
        if (!cancelled) setDecrypted({});
      }
    })();
    return () => { cancelled = true; };
  }, [cryptoKey, data?.cipher]);

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

  const toggleExpanded = (pluginId: string) =>
    setExpanded(e => ({ ...e, [pluginId]: !e[pluginId] }));

  const togglePlugin = async (pluginId: string, currentlyDisabled: boolean) => {
    setToggling(pluginId);
    try {
      const endpoint = currentlyDisabled ? '/api/store/enable' : '/api/store/disable';
      const res = await fetch(endpoint, {
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
      setToggling(null);
    }
  };

  // ── Per-plugin save ────────────────────────────────────────────────────────

  const savePlugin = (pluginId: string, spec: PluginFieldSpec) => async () => {
    if (!data) throw new Error('settings not loaded');

    const plain: Record<string, string | number | boolean | null> = {};
    for (const { key } of (spec.strings ?? [])) {
      const v = plainDrafts[key] !== undefined ? plainDrafts[key] : readPlainString(data, key);
      plain[key] = v.trim() || null;
    }
    for (const { key } of (spec.numbers ?? [])) {
      const raw = plainDrafts[key] !== undefined ? plainDrafts[key] : String(data.plain[key] ?? '');
      plain[key] = raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
    }
    for (const { key } of (spec.bools ?? [])) {
      plain[key] = plainDrafts[key] !== undefined
        ? plainDrafts[key] === 'true'
        : readPlainBool(data, key);
    }

    const merged: Record<string, string> = { ...(decrypted ?? {}) };
    for (const { key } of (spec.secrets ?? [])) {
      if (pendingClear[key]) delete merged[key];
      else if ((secretDrafts[key] ?? '').trim() !== '') merged[key] = secretDrafts[key];
    }

    const next = await saveSettings(
      { plain, secret: Object.keys(merged).length > 0 ? merged : null },
      { cryptoKey },
    );
    onSaved(next);
    setDecrypted(merged);

    // Clear drafts for only this plugin's fields
    const specKeys = new Set([
      ...(spec.secrets ?? []).map(f => f.key),
      ...(spec.strings ?? []).map(f => f.key),
      ...(spec.numbers ?? []).map(f => f.key),
      ...(spec.bools ?? []).map(f => f.key),
    ]);
    setSecretDrafts(d => { const n = { ...d }; for (const k of specKeys) delete n[k]; return n; });
    setPlainDrafts(d => { const n = { ...d }; for (const k of specKeys) delete n[k]; return n; });
    setPendingClear(p => { const n = { ...p }; for (const k of specKeys) delete n[k]; return n; });
    setRevealed(r => { const n = { ...r }; for (const k of specKeys) delete n[k]; return n; });
  };

  // ── Field renderers ────────────────────────────────────────────────────────

  const renderSecret = (f: FieldDef) => {
    const stored = decrypted?.[f.key];
    return (
      <SecretRow
        key={f.key}
        field={f.key}
        label={f.label}
        hint={f.hint}
        multiline={f.multiline}
        isSet={!!stored}
        length={stored ? stored.length : undefined}
        revealed={revealed[f.key] ? stored : undefined}
        draft={secretDrafts[f.key] ?? ''}
        onDraft={v => setSecretDrafts(d => ({ ...d, [f.key]: v }))}
        onClear={() => {
          setPendingClear(p => ({ ...p, [f.key]: true }));
          setSecretDrafts(d => ({ ...d, [f.key]: '' }));
          setRevealed(r => { const n = { ...r }; delete n[f.key]; return n; });
        }}
        onReveal={async () => {
          if (!cryptoKey) throw new Error('encryption key not loaded');
          if (!decrypted && data?.cipher) setDecrypted(await decryptSecretBlob(cryptoKey, data.cipher));
          setRevealed(r => ({ ...r, [f.key]: true }));
        }}
        disabled={!!cryptoUnavailable}
      />
    );
  };

  const renderPlain = (f: FieldDef) => {
    const val = plainDrafts[f.key] !== undefined ? plainDrafts[f.key] : readPlainString(data!, f.key);
    return (
      <PlainTextRow
        key={f.key}
        field={f.key}
        label={f.label}
        hint={f.hint}
        value={val}
        onChange={v => setPlainDrafts(d => ({ ...d, [f.key]: v }))}
      />
    );
  };

  const renderNumber = (f: FieldDef) => {
    const val = plainDrafts[f.key] !== undefined
      ? plainDrafts[f.key]
      : String(data?.plain[f.key] ?? '');
    return (
      <NumberRow
        key={f.key}
        field={f.key}
        label={f.label}
        hint={f.hint}
        value={val === 'undefined' || val === 'null' ? '' : val}
        onChange={v => setPlainDrafts(d => ({ ...d, [f.key]: v }))}
      />
    );
  };

  const renderBool = (f: FieldDef) => {
    const val = plainDrafts[f.key] !== undefined
      ? plainDrafts[f.key] === 'true'
      : readPlainBool(data!, f.key);
    return (
      <BoolRow
        key={f.key}
        field={f.key}
        label={f.label}
        value={val}
        onChange={v => setPlainDrafts(d => ({ ...d, [f.key]: String(v) }))}
      />
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const now = Date.now();

  return (
    <div className="space-y-4">
      {data && (
        <SectionShell
          title="System"
          description="Global flags that apply across all plugins."
          onSave={async () => {
            const plain: Record<string, boolean> = {};
            for (const { key } of SYSTEM_BOOLS) {
              plain[key] = plainDrafts[key] !== undefined
                ? plainDrafts[key] === 'true'
                : readPlainBool(data, key);
            }
            const next = await saveSettings({ plain }, { cryptoKey });
            onSaved(next);
          }}
        >
          {SYSTEM_BOOLS.map(({ key, label }) => (
            <BoolRow
              key={key}
              field={key}
              label={label}
              value={plainDrafts[key] !== undefined ? plainDrafts[key] === 'true' : readPlainBool(data, key)}
              onChange={(v) => setPlainDrafts(d => ({ ...d, [key]: String(v) }))}
            />
          ))}
        </SectionShell>
      )}

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Installed Plugins</h2>
            <p className="text-xs text-zinc-500 mt-1">Plugins enabled for your account. Expand to configure plugin-specific settings.</p>
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
              const isDisabled = row.status === 'disabled';
              const isActive = row.status === 'active' && (expiresMs == null || expiresMs > now);
              const isExpired = !isDisabled && expiresMs != null && expiresMs <= now;
              const expiresLabel = expiresMs ? new Date(expiresMs).toLocaleDateString() : null;
              const installedLabel = new Date(row.installed_at).toLocaleDateString();
              const spec = PLUGIN_FIELDS[row.plugin_id];
              const hasSettings = !!spec && data !== null;
              const isExpanded = !!expanded[row.plugin_id];

              return (
                <div key={row.plugin_id}>
                  {/* Plugin header row */}
                  <div className="flex items-center justify-between gap-4 py-3">
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
                        <Link href="/store" className="text-xs text-amber-300 hover:text-amber-200">Renew →</Link>
                      )}
                      {hasSettings && (
                        <button
                          onClick={() => toggleExpanded(row.plugin_id)}
                          className="text-xs text-zinc-400 hover:text-orange-300 transition"
                        >
                          {isExpanded ? 'collapse ▲' : 'configure ▼'}
                        </button>
                      )}
                      {isFree && (
                        <button
                          onClick={() => setConfirmTarget({ pluginId: row.plugin_id, name })}
                          disabled={uninstalling === row.plugin_id}
                          className="text-xs text-zinc-600 hover:text-red-400 transition disabled:opacity-40"
                        >
                          {uninstalling === row.plugin_id ? 'removing…' : 'uninstall'}
                        </button>
                      )}
                      <label className="flex items-center gap-1.5 cursor-pointer" title={isDisabled ? 'Enable plugin' : 'Disable plugin'}>
                        <input
                          type="checkbox"
                          checked={!isDisabled}
                          disabled={isExpired || toggling === row.plugin_id}
                          onChange={() => void togglePlugin(row.plugin_id, isDisabled)}
                          className="accent-orange-500 cursor-pointer disabled:opacity-40"
                        />
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                          isDisabled
                            ? 'border-zinc-600/30 bg-zinc-800/50 text-zinc-500'
                            : isActive
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                              : 'border-red-500/30 bg-red-500/10 text-red-300'
                        }`}>
                          {isDisabled ? 'disabled' : isActive ? 'active' : 'expired'}
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* Inline plugin settings */}
                  {isExpanded && hasSettings && spec && (
                    <div className="pb-4 pt-1 pl-2">
                      <SectionShell
                        title={`${name} settings`}
                        onSave={savePlugin(row.plugin_id, spec)}
                      >
                        {(spec.secrets ?? []).map(renderSecret)}
                        {(spec.strings ?? []).map(renderPlain)}
                        {(spec.numbers ?? []).map(renderNumber)}
                        {(spec.bools ?? []).map(renderBool)}
                      </SectionShell>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Uninstall confirmation dialog */}
      <dialog
        ref={dialogRef}
        onClose={() => setConfirmTarget(null)}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-700 bg-zinc-900 p-6 text-zinc-100 shadow-2xl backdrop:bg-black/60 max-w-sm w-full"
      >
        <h3 className="text-base font-semibold mb-2">Uninstall {confirmTarget?.name}?</h3>
        <p className="text-sm text-zinc-400 mb-5">
          This will remove the plugin and <span className="text-red-400 font-medium">permanently delete all its saved settings</span>. You will need to re-enter any API keys or config if you reinstall.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={() => setConfirmTarget(null)}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500 transition"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              const id = confirmTarget?.pluginId;
              setConfirmTarget(null);
              if (id) void uninstall(id);
            }}
            className="rounded-lg bg-red-600 hover:bg-red-500 px-4 py-2 text-sm font-medium text-white transition"
          >
            Uninstall
          </button>
        </div>
      </dialog>
    </div>
  );
}
