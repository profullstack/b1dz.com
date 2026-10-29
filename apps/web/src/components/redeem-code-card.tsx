'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/** "Have a code?" — redeem a credit code for Pro days. Lives on /settings. */
export function RedeemCodeCard() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/credits', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (b && typeof b.balance === 'number') setBalance(b.balance); })
      .catch(() => {});
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/credits/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: b.error ?? 'Could not redeem that code.' });
      } else {
        setMsg({ ok: true, text: `Redeemed: ${b.amount} Pro days added.` });
        setBalance(b.balance);
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">Have a code?</h2>
        <div className="flex items-center gap-4 text-xs text-zinc-400">
          {balance !== null && (
            <span>Pro days: <span className="font-semibold text-orange-300">{balance}</span></span>
          )}
          <Link href="/invites" className="text-orange-400 hover:text-orange-300">Invites</Link>
        </div>
      </div>
      <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          aria-label="Credit code"
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm uppercase outline-none transition focus:border-orange-500"
          placeholder="CR-XXXX-XXXX-XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2 text-sm font-semibold text-black transition hover:from-orange-400 hover:to-amber-400 disabled:opacity-50"
        >
          {busy ? 'Redeeming…' : 'Redeem'}
        </button>
      </form>
      {msg && (
        <p className={`mt-2 text-xs ${msg.ok ? 'text-emerald-300' : 'text-red-300'}`} role="status">{msg.text}</p>
      )}
    </section>
  );
}
