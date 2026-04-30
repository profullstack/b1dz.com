import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';
import { PLUGIN_CATALOG, type CatalogEntry } from '@b1dz/core';
import { createServerSupabase } from '@/lib/supabase';
import { coinpayConfigured } from '@/lib/coinpay-client';
import { InstallButton } from './install-button';

export const metadata: Metadata = {
  title: 'b1dz Store — Plugin Marketplace',
  description: 'Browse and install DEX connectors and trading strategies for b1dz. Signals-only execution — authors never touch your keys.',
};
export const dynamic = 'force-dynamic';

const kindLabels: Record<string, string> = {
  connector: 'DEX Connector',
  strategy: 'Strategy',
};

const statusStyles: Record<CatalogEntry['status'], string> = {
  ready: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  preview: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  'coming-soon': 'bg-zinc-500/10 text-zinc-400 border-zinc-600/30',
};

const statusLabels: Record<CatalogEntry['status'], string> = {
  ready: 'Ready',
  preview: 'Preview',
  'coming-soon': 'Coming soon',
};

function priceLabel(pricing: CatalogEntry['pricing']): string {
  if (pricing.model === 'free') return 'Free';
  if (pricing.model === 'subscription') return `$${pricing.usdPerMonth}/mo`;
  return `${pricing.bps / 100}% rev share`;
}

interface InstalledRow {
  plugin_id: string;
  status: string;
  paid_until: string | null;
}

async function fetchInstalled(): Promise<Map<string, InstalledRow>> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Map();
  const { data } = await supabase
    .from('user_installed_plugins')
    .select('plugin_id, status, paid_until')
    .eq('user_id', user.id);
  const map = new Map<string, InstalledRow>();
  for (const r of (data ?? []) as InstalledRow[]) map.set(r.plugin_id, r);
  return map;
}

export default async function StorePage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  const installed = user ? await fetchInstalled() : new Map<string, InstalledRow>();
  const cpOk = coinpayConfigured();

  const connectors = PLUGIN_CATALOG.filter((e) => e.manifest.kind === 'connector');
  const strategies = PLUGIN_CATALOG.filter((e) => e.manifest.kind === 'strategy');

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="flex items-center justify-between max-w-6xl mx-auto px-6 py-4">
        <Link href="/" className="flex items-center">
          <Image src="/logo.svg" alt="b1dz" width={200} height={64} />
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-200 transition">Home</Link>
          <Link href="/store" className="text-sm text-orange-400 hover:text-orange-300 transition">Store</Link>
          {user ? (
            <>
              <Link href="/dashboard" className="text-sm text-zinc-400 hover:text-zinc-200 transition">Dashboard</Link>
              <Link href="/settings" className="text-sm text-zinc-400 hover:text-zinc-200 transition">Settings</Link>
              <span className="text-sm text-zinc-500">{user.email}</span>
              <form action="/api/auth/logout" method="POST">
                <button className="text-sm text-zinc-500 hover:text-zinc-300 transition">Sign out</button>
              </form>
            </>
          ) : (
            <>
              <Link href="/login" className="text-sm text-zinc-400 hover:text-zinc-200 transition">Sign in</Link>
              <Link href="/signup" className="text-sm bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-medium px-4 py-2 rounded-lg transition">Get started</Link>
            </>
          )}
        </div>
      </nav>

      <section className="max-w-6xl mx-auto px-6 pt-16 pb-10 text-center">
        <h1 className="text-5xl md:text-6xl font-bold mb-4 leading-tight">
          <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">Plugin Store</span>
        </h1>
        <p className="text-xl text-zinc-400 max-w-2xl mx-auto">
          DEX connectors and trading strategies for the b1dz terminal. Signals-only — plugin authors never touch your keys.
        </p>
        {user && !cpOk && (
          <div className="mt-6 inline-block rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
            Operator note: Coinpay not configured — paid plugin purchases disabled until env vars land.
          </div>
        )}
      </section>

      <section className="max-w-6xl mx-auto px-6 py-10">
        <SectionHeader title="DEX Connectors" count={connectors.length} />
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
          {connectors.map((e) => (
            <PluginCard key={e.manifest.id} entry={e} loggedIn={!!user} installed={installed.get(e.manifest.id) ?? null} coinpayConfigured={cpOk} />
          ))}
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 py-10">
        <SectionHeader title="Strategies" count={strategies.length} />
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
          {strategies.map((e) => (
            <PluginCard key={e.manifest.id} entry={e} loggedIn={!!user} installed={installed.get(e.manifest.id) ?? null} coinpayConfigured={cpOk} />
          ))}
        </div>
      </section>

      <footer className="border-t border-zinc-800 py-8 text-center text-zinc-500 text-sm">
        <p>&copy; {new Date().getFullYear()} b1dz.com — AI Arbitrage Terminal</p>
      </footer>
    </main>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between mb-6">
      <h2 className="text-2xl font-bold">
        <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">{title}</span>
      </h2>
      <span className="text-sm text-zinc-500">{count} listed</span>
    </div>
  );
}

function PluginCard({ entry, loggedIn, installed, coinpayConfigured: cpOk }: {
  entry: CatalogEntry;
  loggedIn: boolean;
  installed: InstalledRow | null;
  coinpayConfigured: boolean;
}) {
  const { manifest, status, pricing, tagline } = entry;
  return (
    <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 px-6 py-5 hover:border-orange-500/30 transition">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">{kindLabels[manifest.kind] ?? manifest.kind}</div>
          <h3 className="text-lg font-semibold text-zinc-100 leading-tight">{manifest.name}</h3>
          <div className="text-xs text-zinc-500 mt-1">by {manifest.author ?? 'unknown'} · v{manifest.version}</div>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${statusStyles[status]}`}>
          {statusLabels[status]}
        </span>
      </div>
      {tagline && <p className="text-sm text-zinc-300 mb-2">{tagline}</p>}
      {manifest.description && <p className="text-sm text-zinc-400 leading-relaxed mb-4">{manifest.description}</p>}
      <div className="mt-auto flex items-center justify-between pt-3 border-t border-zinc-800 gap-3">
        <div className="flex flex-wrap gap-1.5">
          {manifest.capabilities.slice(0, 3).map((c) => (
            <span key={c} className="rounded-md bg-zinc-950 border border-zinc-800 px-2 py-0.5 text-[10px] font-mono text-zinc-400">
              {c}
            </span>
          ))}
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className="text-sm font-semibold text-zinc-200 whitespace-nowrap">{priceLabel(pricing)}</span>
          <InstallButton entry={entry} loggedIn={loggedIn} installed={installed} coinpayConfigured={cpOk} />
        </div>
      </div>
    </div>
  );
}
