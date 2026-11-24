import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { SignOutForm } from '@/components/sign-out-form';
import { researchCatalog } from '@/lib/research-api';
import { createServerSupabase } from '@/lib/supabase';
import { TerminalClient } from './terminal-client';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'b1dz terminal: market research',
  description:
    'A keyboard-driven market research terminal in the browser: equities, options, yield curves, credit, FX, futures, energy, shipping, macro, SEC filings and news from public and official sources.',
  alternates: { canonical: '/terminal' },
};

/**
 * The research terminal. Public: anyone can browse the dashboards and what
 * each card shows. Loading live data needs a signed-in user, because each
 * card is a fetch from a public source on the caller's behalf.
 */
export default async function TerminalPage() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { dashboards, cards } = researchCatalog();

  return (
    <main className="flex h-[100dvh] flex-col bg-zinc-950 text-zinc-100">
      <nav className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <div className="flex items-end gap-3">
          <Link href="/" aria-label="b1dz home" className="inline-flex items-center">
            <Image src="/favicon.svg" alt="b1dz" width={28} height={28} className="block transition hover:opacity-80" />
          </Link>
          <h1 className="pb-0.5 font-mono text-sm leading-none text-zinc-300">&gt; terminal</h1>
          <span className="hidden pb-0.5 text-xs leading-none text-zinc-600 sm:inline">
            {dashboards.length} dashboards · {cards.length} cards
          </span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          {user ? (
            <>
              <Link href="/dashboard" className="text-zinc-400 hover:text-zinc-200">
                Dashboard
              </Link>
              <Link href="/console" className="hidden text-zinc-400 hover:text-zinc-200 sm:inline">
                Console
              </Link>
              <span className="hidden text-zinc-500 md:inline">{user.email}</span>
              <SignOutForm className="text-zinc-500 hover:text-zinc-300" />
            </>
          ) : (
            <>
              <Link href="/login?next=/terminal" className="text-zinc-300 hover:text-white">
                Sign in
              </Link>
              <Link href="/signup" className="rounded bg-amber-400 px-2 py-0.5 text-zinc-950 hover:bg-amber-300">
                Sign up
              </Link>
            </>
          )}
        </div>
      </nav>
      <TerminalClient catalog={{ dashboards, cards }} signedIn={Boolean(user)} />
    </main>
  );
}
