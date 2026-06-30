import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';
import { createServerSupabase } from '@/lib/supabase';
import { SignOutForm } from '@/components/sign-out-form';
import { StrategyBuilder } from './builder-client';

export const metadata: Metadata = {
  title: 'Strategy Builder — b1dz',
  description: 'Build your own trading strategy with the Trading Strategy Protocol (TSP) and backtest it instantly on crypto and equities.',
};
export const dynamic = 'force-dynamic';

export default async function BuildPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="flex items-center justify-between max-w-6xl mx-auto px-6 py-4">
        <Link href="/" className="flex items-center">
          <Image src="/logo.svg" alt="b1dz" width={200} height={64} />
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/store" className="text-sm text-zinc-400 hover:text-zinc-200 transition">Store</Link>
          <Link href="/store/build" className="text-sm text-orange-400 hover:text-orange-300 transition">Build</Link>
          {user ? (
            <>
              <Link href="/dashboard" className="text-sm text-zinc-400 hover:text-zinc-200 transition">Dashboard</Link>
              <span className="text-sm text-zinc-500">{user.email}</span>
              <SignOutForm className="text-sm text-zinc-500 hover:text-zinc-300 transition" />
            </>
          ) : (
            <Link href="/login" className="text-sm text-zinc-400 hover:text-zinc-200 transition">Sign in</Link>
          )}
        </div>
      </nav>

      <section className="max-w-6xl mx-auto px-6 pt-12 pb-6">
        <h1 className="text-4xl md:text-5xl font-bold mb-3 leading-tight">
          <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">Strategy Builder</span>
        </h1>
        <p className="text-lg text-zinc-400 max-w-3xl">
          Describe a strategy as data with the open{' '}
          <a href="/spec/tsp/v0.1/tsp.schema.json" className="text-orange-400 underline-offset-4 hover:underline">Trading Strategy Protocol</a>{' '}
          — no code — then backtest its own buy/sell signals on crypto and equities to see which it suits.
        </p>
      </section>

      {user ? (
        <StrategyBuilder />
      ) : (
        <section className="max-w-6xl mx-auto px-6 py-16">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-6 py-8 text-center">
            <p className="text-zinc-300 mb-4">Sign in to build and backtest your own strategy.</p>
            <Link href="/login" className="inline-block bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-medium px-5 py-2.5 rounded-lg transition">Sign in</Link>
          </div>
        </section>
      )}
    </main>
  );
}
