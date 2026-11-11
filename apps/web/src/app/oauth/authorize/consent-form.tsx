'use client';
import { useState } from 'react';

interface Props {
  params: Record<string, string>;
  clientName: string;
  clientUri: string | null;
  redirectHost: string;
  account: string;
}

/**
 * The consent decision. Posts JSON with the cookie session (same origin) and
 * then navigates to the returned redirect itself: a form POST that 303s to
 * claude.ai / chatgpt.com would be blocked by the site's CSP form-action.
 */
export default function ConsentForm({ params, clientName, clientUri, redirectHost, account }: Props) {
  const [trade, setTrade] = useState(false);
  const [budget, setBudget] = useState('50');
  const [windowSel, setWindowSel] = useState('daily');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...params, approve, trade, budget_usd: Number(budget), budget_window: windowSel }),
      });
      const data = (await res.json().catch(() => ({}))) as { redirect?: string; error_description?: string; error?: string };
      if (!res.ok || !data.redirect) {
        setError(data.error_description || data.error || 'Could not complete the request');
        setBusy(false);
        return;
      }
      window.location.assign(data.redirect);
    } catch {
      setError('Network error');
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-md space-y-5 bg-zinc-900 border border-zinc-800 rounded-xl p-6">
      <h1 className="text-xl font-semibold">
        Allow <span className="text-orange-400">{clientName}</span> to use your b1dz account?
      </h1>
      <p className="text-sm text-zinc-400">
        Signed in as <span className="text-zinc-200">{account}</span>. {clientName} gets its own agent sub-account: it can read your
        budget, portfolio and quotes through the b1dz MCP tools. It can place crypto buys only if you give it a trading budget below, and
        never more than that budget per window. It shows up with your agent tokens in Settings, where you can change or revoke it.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={trade} onChange={(e) => setTrade(e.target.checked)} />
        Allow it to place crypto buys
      </label>
      {trade && (
        <div className="flex gap-3 text-sm">
          <label className="flex-1">
            <span className="block text-zinc-400 mb-1">Budget (USD)</span>
            <input
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2"
              type="number"
              min="1"
              step="1"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
          <label className="flex-1">
            <span className="block text-zinc-400 mb-1">Per</span>
            <select className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2" value={windowSel} onChange={(e) => setWindowSel(e.target.value)}>
              <option value="daily">day</option>
              <option value="weekly">week</option>
              <option value="monthly">month</option>
            </select>
          </label>
        </div>
      )}
      <p className="text-xs text-zinc-500">
        After you decide, you go back to <span className="text-zinc-300">{redirectHost}</span>.
        {clientUri ? <> Client site: {clientUri}</> : null}
      </p>
      {error && <div className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</div>}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(true)}
          className="flex-1 py-2 rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 text-black font-semibold disabled:opacity-50"
        >
          Allow
        </button>
        <button type="button" disabled={busy} onClick={() => decide(false)} className="flex-1 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50">
          Deny
        </button>
      </div>
    </div>
  );
}
