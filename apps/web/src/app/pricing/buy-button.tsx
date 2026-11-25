'use client';

import { useState } from 'react';

/** Opens a CoinPay hosted checkout for a b1dz product; signed-out visitors go to sign in first. */
export function BuyButton({ product, label, signedIn, primary }: { product: string; label: string; signedIn: boolean; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cls = `inline-block w-full rounded-lg px-4 py-2 text-center text-sm font-semibold disabled:opacity-50 ${
    primary ? 'bg-orange-600 text-white hover:bg-orange-500' : 'border border-zinc-700 text-zinc-100 hover:border-zinc-500'
  }`;
  if (!signedIn) {
    return (
      <a href={`/login?next=${encodeURIComponent('/pricing')}`} className={cls}>
        Sign in to buy
      </a>
    );
  }
  const buy = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/billing/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || !b.checkoutUrl) throw new Error(b.error ?? 'Could not open checkout.');
      window.location.assign(b.checkoutUrl);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div>
      <button onClick={buy} disabled={busy} className={cls}>
        {busy ? 'Opening CoinPay…' : label}
      </button>
      {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
    </div>
  );
}
