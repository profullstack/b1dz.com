'use client';

import { useCallback, useEffect, useState } from 'react';

interface InviteView {
  id: string;
  note: string;
  createdAt: number;
  expiresAt: number | null;
  usedAt: number | null;
  status: 'open' | 'used' | 'expired' | 'revoked';
  bonus?: 'pending' | 'granted' | 'denied' | null;
  bonusReason?: string | null;
}
interface Overview {
  quota: { total: number; used: number; left: number };
  invites: InviteView[];
  canInvite: boolean;
  blockedReason: string | null;
  bonusDays: number;
  proDays: number;
  affiliateUrl: string;
  joinedOnInvite: boolean;
  joinBonus: { status: string; reason: string | null } | null;
  canAcceptInvite: boolean;
}

const BONUS_TEXT: Record<string, string> = {
  granted: 'bonus paid',
  pending: 'bonus pending',
  denied: 'no bonus',
};

function fmt(ms: number | null) {
  return ms ? new Date(ms).toLocaleDateString() : '';
}

export function InvitesClient() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [fresh, setFresh] = useState<{ code: string; url: string } | null>(null);
  const [accept, setAccept] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch('/api/invites', { cache: 'no-store' });
    if (r.ok) setData(await r.json());
    else setError('Could not load your invites.');
  }, []);
  useEffect(() => { void load(); }, [load]);

  const call = async (url: string, init: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json' } });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setError(b.error ?? 'Something went wrong.'); return null; }
      await load();
      return b;
    } finally {
      setBusy(false);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const b = await call('/api/invites', { method: 'POST', body: JSON.stringify({ note }) });
    if (b) { setFresh({ code: b.code, url: b.url }); setNote(''); setCopied(false); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* no clipboard */ }
  };

  if (!data) {
    return <p className="text-sm text-zinc-500">{error ?? 'loading…'}</p>;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Invites</h1>
        <p className="text-sm text-zinc-400">
          You have <span className="font-semibold text-zinc-200">{data.quota.left}</span> of {data.quota.total} invites left.
          When someone new joins on yours and confirms their email, you both get {data.bonusDays} Pro days.
          Your balance: <span className="font-semibold text-orange-300">{data.proDays}</span> Pro days.
        </p>
      </header>

      {error && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-sm font-semibold text-zinc-200">Send an invite</h2>
        {data.canInvite ? (
          <form onSubmit={create} className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              aria-label="Who is it for? (optional)"
              className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-orange-500"
              placeholder="Who is it for? (optional, only you see this)"
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              type="submit"
              disabled={busy || data.quota.left < 1}
              className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
            >
              Create invite
            </button>
          </form>
        ) : (
          <p className="mt-2 text-sm text-zinc-400">{data.blockedReason}</p>
        )}
        {fresh && (
          <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
            <p className="text-emerald-300">Copy this link now. The code is shown only once.</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 break-all rounded bg-zinc-950 px-2 py-1 text-xs text-zinc-200">{fresh.url}</code>
              <button onClick={() => copy(fresh.url)} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs hover:border-orange-500">
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}
      </section>

      {data.invites.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h2 className="text-sm font-semibold text-zinc-200">Sent</h2>
          <ul className="mt-2 divide-y divide-zinc-800 text-sm">
            {data.invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <span className="text-zinc-200">{i.note || 'Invite'}</span>
                  <span className="ml-2 text-xs text-zinc-500">created {fmt(i.createdAt)}</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className={i.status === 'used' ? 'text-emerald-300' : i.status === 'open' ? 'text-zinc-300' : 'text-zinc-500'}>
                    {i.status === 'open' && i.expiresAt ? `open until ${fmt(i.expiresAt)}` : i.status}
                    {i.status === 'used' && i.bonus ? `, ${BONUS_TEXT[i.bonus] ?? i.bonus}` : ''}
                  </span>
                  {i.status === 'open' && (
                    <button
                      disabled={busy}
                      onClick={() => call(`/api/invites/${encodeURIComponent(i.id)}`, { method: 'DELETE' })}
                      className="text-zinc-500 hover:text-red-300"
                    >
                      withdraw
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.canAcceptInvite && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h2 className="text-sm font-semibold text-zinc-200">Were you invited?</h2>
          <form
            onSubmit={async (e) => { e.preventDefault(); if (await call('/api/invites/accept', { method: 'POST', body: JSON.stringify({ code: accept }) })) setAccept(''); }}
            className="mt-3 flex flex-col gap-2 sm:flex-row"
          >
            <input
              aria-label="Invite code"
              className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm uppercase outline-none focus:border-orange-500"
              placeholder="INV-XXXX-XXXX-XXXX"
              value={accept}
              onChange={(e) => setAccept(e.target.value)}
            />
            <button type="submit" disabled={busy || !accept.trim()} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:border-orange-500 disabled:opacity-50">
              Accept invite
            </button>
          </form>
        </section>
      )}
      {data.joinedOnInvite && data.joinBonus && (
        <p className="text-xs text-zinc-500">You joined on an invite: {BONUS_TEXT[data.joinBonus.status] ?? data.joinBonus.status}.</p>
      )}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-sm font-semibold text-zinc-200">Your referral link</h2>
        <p className="mt-1 text-xs text-zinc-500">Open to anyone, no limit. New accounts that arrive through it are credited to you.</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 break-all rounded bg-zinc-950 px-2 py-1 text-xs text-zinc-200">{data.affiliateUrl}</code>
          <button onClick={() => copy(data.affiliateUrl)} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs hover:border-orange-500">Copy</button>
        </div>
      </section>
    </div>
  );
}
