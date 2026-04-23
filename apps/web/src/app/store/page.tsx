import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';
import { PLUGIN_CATALOG, type CatalogEntry } from '@b1dz/core';

export const metadata: Metadata = {
  title: 'b1dz Store — Plugin Marketplace',
  description: 'Browse and install DEX connectors and trading strategies for b1dz. Signals-only execution — authors never touch your keys.',
};

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

export default function StorePage() {
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
          <Link href="/login" className="text-sm text-zinc-400 hover:text-zinc-200 transition">Sign in</Link>
          <Link href="/signup" className="text-sm bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-medium px-4 py-2 rounded-lg transition">Get started</Link>
        </div>
      </nav>

      <section className="max-w-6xl mx-auto px-6 pt-16 pb-10 text-center">
        <h1 className="text-5xl md:text-6xl font-bold mb-4 leading-tight">
          <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">Plugin Store</span>
        </h1>
        <p className="text-xl text-zinc-400 max-w-2xl mx-auto">
          DEX connectors and trading strategies for the b1dz terminal. Signals-only — plugin authors never touch your keys.
        </p>
        <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/70 px-4 py-2 text-xs uppercase tracking-[0.3em] text-zinc-500">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
          v0 — preview catalog. <span className="font-mono normal-case tracking-normal text-orange-400 ml-1">b1dz store install</span> lands with the registry.
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 py-10">
        <SectionHeader title="DEX Connectors" count={connectors.length} />
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
          {connectors.map((e) => (
            <PluginCard key={e.manifest.id} entry={e} />
          ))}
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 py-10">
        <SectionHeader title="Strategies" count={strategies.length} />
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
          {strategies.map((e) => (
            <PluginCard key={e.manifest.id} entry={e} />
          ))}
        </div>
        <p className="mt-6 text-center text-sm text-zinc-500">
          The in-repo strategies are placeholders. The authoring SDK opens soon —{' '}
          <Link href="/signup" className="text-orange-400 hover:text-orange-300 transition">sign up</Link> to get notified.
        </p>
      </section>

      <section className="max-w-5xl mx-auto px-6 py-16">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-8 py-10">
          <h2 className="text-2xl font-bold mb-3">
            <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">Sell your strategy on b1dz</span>
          </h2>
          <p className="text-zinc-400 mb-6 max-w-3xl">
            Authors publish a strategy as a signal stream. b1dz&apos;s engine applies each user&apos;s risk limits, signs trades, and tracks realized-vs-expected PnL. You never need a user&apos;s keys. Revenue is attributed per signal.
          </p>
          <div className="grid sm:grid-cols-3 gap-4 text-sm">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <div className="text-zinc-500 uppercase tracking-wider text-xs mb-1">Sandbox</div>
              <div className="text-zinc-200">Signals-only. No wallet access, ever.</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <div className="text-zinc-500 uppercase tracking-wider text-xs mb-1">Payout</div>
              <div className="text-zinc-200">Monthly subscription or PnL rev-share — author picks.</div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <div className="text-zinc-500 uppercase tracking-wider text-xs mb-1">Attribution</div>
              <div className="text-zinc-200">Expected vs realized tracked per-signal, not per-bundle.</div>
            </div>
          </div>
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

function PluginCard({ entry }: { entry: CatalogEntry }) {
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
      <div className="mb-4">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Install</div>
        <code className="block rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs font-mono text-orange-300 overflow-x-auto">
          b1dz store install {manifest.id}
        </code>
      </div>
      <div className="mt-auto flex items-center justify-between pt-3 border-t border-zinc-800">
        <div className="flex flex-wrap gap-1.5">
          {manifest.capabilities.map((c) => (
            <span key={c} className="rounded-md bg-zinc-950 border border-zinc-800 px-2 py-0.5 text-[10px] font-mono text-zinc-400">
              {c}
            </span>
          ))}
        </div>
        <span className="text-sm font-semibold text-zinc-200 whitespace-nowrap ml-3">{priceLabel(pricing)}</span>
      </div>
    </div>
  );
}
