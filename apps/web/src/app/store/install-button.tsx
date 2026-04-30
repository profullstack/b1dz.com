'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CatalogEntry } from '@b1dz/core';

const SUPPORTED_BLOCKCHAINS = [
  'BTC', 'BCH', 'ETH', 'POL', 'SOL',
  'USDC_ETH', 'USDC_POL', 'USDC_BASE', 'USDC_SOL',
] as const;

interface Props {
  entry: CatalogEntry;
  loggedIn: boolean;
  installed: { paid_until: string | null; status: string } | null;
  coinpayConfigured: boolean;
}

export function InstallButton({ entry, loggedIn, installed, coinpayConfigured }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPay, setShowPay] = useState<'install' | 'renew' | null>(null);
  const [blockchain, setBlockchain] = useState<typeof SUPPORTED_BLOCKCHAINS[number]>('USDC_BASE');

  if (entry.status === 'coming-soon') {
    return <span className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-1.5 text-xs text-zinc-500">Coming soon</span>;
  }

  if (!loggedIn) {
    return <Link href="/signup" className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 hover:border-orange-500 hover:text-orange-300 transition">Sign up to install</Link>;
  }

  const isFree = entry.pricing.model === 'free';
  const isSubscription = entry.pricing.model === 'subscription';
  const isRevshare = entry.pricing.model === 'revshare';
  const paidUntilMs = installed?.paid_until ? new Date(installed.paid_until).getTime() : null;
  const isActive = !!installed && installed.status === 'active' && (paidUntilMs == null || paidUntilMs > Date.now());
  const isExpired = !!installed && paidUntilMs != null && paidUntilMs <= Date.now();

  async function doInstall(mode: 'install' | 'renew') {
    setBusy(true); setError(null);
    try {
      const path = mode === 'renew' ? '/api/store/renew' : '/api/store/install';
      const body: Record<string, unknown> = { pluginId: entry.manifest.id };
      if (isSubscription) body.blockchain = blockchain;
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`${res.status}: ${txt.slice(0, 200)}`);
      }
      const data = await res.json() as { invoice?: { invoiceId: string }; installed?: boolean };
      if (data.invoice?.invoiceId) {
        router.push(`/store/invoice/${data.invoice.invoiceId}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Free / revshare: simple Install button (or Installed badge).
  if (isFree || isRevshare) {
    if (installed) {
      return <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">Installed ✓</span>;
    }
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => doInstall('install')}
          disabled={busy}
          className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-medium px-3 py-1.5 text-xs disabled:opacity-50 transition"
        >
          {busy ? 'installing…' : 'Install'}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    );
  }

  // Subscription
  const renderPayModal = (mode: 'install' | 'renew') => (
    <div className="absolute right-0 top-full mt-2 w-72 rounded-lg border border-zinc-700 bg-zinc-950 p-3 shadow-xl z-10">
      <div className="text-xs text-zinc-400 mb-2">
        Pay <span className="font-semibold text-zinc-200">${entry.pricing.model === 'subscription' ? entry.pricing.usdPerMonth : 0}/mo</span> in:
      </div>
      <select
        value={blockchain}
        onChange={(e) => setBlockchain(e.target.value as typeof SUPPORTED_BLOCKCHAINS[number])}
        className="mb-2 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100"
      >
        {SUPPORTED_BLOCKCHAINS.map((b) => <option key={b} value={b}>{b}</option>)}
      </select>
      <div className="flex items-center gap-2">
        <button
          onClick={() => { void doInstall(mode); }}
          disabled={busy || !coinpayConfigured}
          className="flex-1 rounded bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-medium px-3 py-1.5 text-xs disabled:opacity-50 transition"
        >
          {busy ? '…' : (mode === 'renew' ? 'Renew' : 'Pay & install')}
        </button>
        <button
          onClick={() => setShowPay(null)}
          className="rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
        >
          cancel
        </button>
      </div>
      {!coinpayConfigured && <p className="mt-2 text-[10px] text-amber-400">Coinpay not configured on server.</p>}
      {error && <p className="mt-2 text-[10px] text-red-400">{error}</p>}
    </div>
  );

  if (isActive) {
    const expiresLabel = paidUntilMs ? new Date(paidUntilMs).toLocaleDateString() : 'never';
    return (
      <div className="relative flex items-center gap-2">
        <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">
          Active until {expiresLabel}
        </span>
        <button
          onClick={() => setShowPay(showPay === 'renew' ? null : 'renew')}
          className="text-xs text-zinc-400 hover:text-orange-300 transition"
        >
          Renew
        </button>
        {showPay === 'renew' && renderPayModal('renew')}
      </div>
    );
  }

  if (isExpired) {
    return (
      <div className="relative">
        <button
          onClick={() => setShowPay(showPay === 'renew' ? null : 'renew')}
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-500/20 transition"
        >
          Expired — Renew
        </button>
        {showPay === 'renew' && renderPayModal('renew')}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowPay(showPay === 'install' ? null : 'install')}
        className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-medium px-3 py-1.5 text-xs transition"
      >
        Buy &amp; install
      </button>
      {showPay === 'install' && renderPayModal('install')}
    </div>
  );
}
