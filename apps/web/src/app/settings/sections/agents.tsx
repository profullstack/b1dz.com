'use client';

import { useEffect, useState } from 'react';
import { SectionShell } from '../shared';

interface TokenRecord {
  id: string;
  name: string;
  token_suffix: string;
  scopes: string[];
  budget_usd: number;
  budget_window: string;
  allowed_symbols: string[] | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

const ALL_SCOPES = ['read', 'trade:crypto', 'trade:equity'] as const;

/**
 * Agents (the "Coinbase for Agents" sub-accounts). Create scoped tokens that an
 * external AI (Claude, ChatGPT, an MCP client) presents to trade on your
 * behalf, each hard-capped by its own spend budget. The MCP endpoint is
 * `/api/agent/mcp`; the REST surface is under `/api/agent/*`.
 */
export function AgentsSection() {
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('my-agent');
  const [scopes, setScopes] = useState<string[]>(['read', 'trade:crypto']);
  const [budget, setBudget] = useState('50');
  const [window, setWindow] = useState('daily');
  const [symbols, setSymbols] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const res = await fetch('/api/agent/tokens', { cache: 'no-store' }).catch(() => null);
    const body = res?.ok ? ((await res.json()) as { tokens: TokenRecord[] }) : null;
    setTokens(body?.tokens ?? []);
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  const toggleScope = (s: string) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const onCreate = async () => {
    setError(null);
    setCreated(null);
    const res = await fetch('/api/agent/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        scopes,
        budgetUsd: Number(budget),
        budgetWindow: window,
        allowedSymbols: symbols.trim() ? symbols.split(',').map((s) => s.trim()).filter(Boolean) : null,
      }),
    }).catch(() => null);
    const body = res ? ((await res.json().catch(() => null)) as { token?: string; error?: string } | null) : null;
    if (!res?.ok || !body?.token) {
      setError(body?.error ?? 'failed to create token');
      return;
    }
    setCreated(body.token);
    await refresh();
  };

  const onRevoke = async (id: string) => {
    await fetch(`/api/agent/tokens/${id}`, { method: 'DELETE' }).catch(() => null);
    await refresh();
  };

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        Agent tokens let an external AI place crypto trades within a fixed spend budget — a sub-account limit. Connect an MCP
        client to <span className="font-mono text-amber-300">/api/agent/mcp</span> with the token as a Bearer credential. A
        token is shown <span className="text-amber-300">once</span> at creation; store it securely. Revoke anytime.
      </p>

      <SectionShell title="Create agent token" description="Scope it tightly: grant trade:crypto only if the agent should place orders, and set a budget you're comfortable losing. Click Save to create." onSave={onCreate}>
        <div className="space-y-3 py-1">
          <label className="block text-sm text-zinc-300">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
          </label>
          <div className="text-sm text-zinc-300">
            Scopes
            <div className="mt-1 flex flex-wrap gap-3">
              {ALL_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} />
                  <span className="font-mono">{s}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex gap-3">
            <label className="flex-1 text-sm text-zinc-300">
              Budget (USD)
              <input value={budget} onChange={(e) => setBudget(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
            </label>
            <label className="text-sm text-zinc-300">
              Window
              <select value={window} onChange={(e) => setWindow(e.target.value)} className="mt-1 block rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100">
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
              </select>
            </label>
          </div>
          <label className="block text-sm text-zinc-300">
            Allowed symbols (optional, comma-separated)
            <input value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder="BTC-USD,ETH-USD — blank = any" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
          </label>
        </div>
      </SectionShell>

      {error && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
      {created && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <p className="mb-1 font-semibold">Token created — copy it now, it won&apos;t be shown again:</p>
          <code className="block break-all rounded bg-zinc-950 px-2 py-1 font-mono text-emerald-300">{created}</code>
        </div>
      )}

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <header className="mb-4">
          <h2 className="text-lg font-semibold text-zinc-100">Active tokens</h2>
          <p className="mt-1 text-xs text-zinc-500">Revoking is immediate and cannot be undone.</p>
        </header>
        {loading && <p className="text-sm text-zinc-500">loading…</p>}
        {!loading && tokens.length === 0 && <p className="text-sm text-zinc-500">No agent tokens yet.</p>}
        <div className="space-y-2">
          {tokens.filter((t) => !t.revoked_at).map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 px-3 py-2 text-sm">
              <div>
                <div className="text-zinc-200">{t.name} <span className="font-mono text-zinc-500">…{t.token_suffix}</span></div>
                <div className="text-xs text-zinc-500">
                  ${Number(t.budget_usd).toFixed(0)}/{t.budget_window} · {t.scopes.join(', ')}
                  {t.allowed_symbols?.length ? ` · ${t.allowed_symbols.join(',')}` : ' · any symbol'}
                </div>
              </div>
              <button onClick={() => onRevoke(t.id)} className="rounded-md border border-red-500/40 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10">
                Revoke
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
