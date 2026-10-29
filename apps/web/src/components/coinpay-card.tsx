'use client';

import { useState } from 'react';

/** Settings -> CoinPay: Connect, or Disconnect (refused when it is the only way in). */
export function CoinpayCard({ linked, coinpayOnly }: { linked: boolean; coinpayOnly: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isLinked, setLinked] = useState(linked);

  const disconnect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/v1/coinpay/disconnect', { method: 'POST' });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || !b.ok) setMsg({ ok: false, text: b.error ?? 'Could not disconnect.' });
      else {
        setLinked(false);
        setMsg({ ok: true, text: 'CoinPay disconnected.' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h2 className="text-sm font-semibold text-zinc-200">CoinPay</h2>
      {isLinked ? (
        coinpayOnly ? (
          <p className="mt-2 text-xs text-zinc-400">
            This account was made with CoinPay, which is its only way in, so it cannot be disconnected.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
            <span>Connected: you can sign in here with CoinPay.</span>
            <button onClick={disconnect} disabled={busy} className="text-orange-400 hover:text-orange-300 disabled:opacity-50">
              {busy ? 'Disconnecting...' : 'Disconnect CoinPay'}
            </button>
          </div>
        )
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
          <span>Connect your CoinPay account to sign in here with it.</span>
          <a href="/api/v1/coinpay/oauth/start?mode=connect" className="text-orange-400 hover:text-orange-300">Connect CoinPay</a>
        </div>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</p>}
    </section>
  );
}
