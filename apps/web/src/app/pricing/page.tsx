import Link from 'next/link';
import Image from 'next/image';
import { createServerSupabase } from '@/lib/supabase';
import { monetizationConfig } from '@/lib/monetization';
import { BuyButton } from './buy-button';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'b1dz pricing: Pro passes, free analyst, agent pricing',
  description: 'b1dz Pro is a prepaid pass paid in crypto through CoinPay: 30 days for $25 or 365 days for $199. The research terminal and quotes are free. Agents pay per call in USDC.',
  alternates: { canonical: '/pricing' },
};

const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ paid?: string }> }) {
  const sp = await searchParams;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
  const cfg = monetizationConfig();
  const signedIn = !!user;
  const perMonth365 = cfg.pro365PriceUsd / 12;

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.svg" alt="b1dz" width={24} height={24} />
          <span className="text-base font-bold bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">b1dz</span>
        </Link>
        <div className="flex items-center gap-4 text-sm text-zinc-400">
          <Link href="/terminal" className="hover:text-zinc-200">terminal</Link>
          {signedIn ? <Link href="/settings" className="hover:text-zinc-200">settings</Link> : <Link href="/login?next=/pricing" className="hover:text-zinc-200">sign in</Link>}
        </div>
      </nav>

      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        {sp.paid && (
          <p className="mb-6 rounded-lg border border-green-800 bg-green-950/40 px-4 py-3 text-sm text-green-300">
            Payment received. Your Pro days or agent credit are on your account; see <Link href="/settings" className="underline">Settings</Link>.
          </p>
        )}
        <h1 className="text-3xl font-bold">Pricing</h1>
        <p className="mt-2 max-w-2xl text-zinc-400">
          The research terminal, every quote and the trading tools are free. Pro adds the AI analyst. You pay once for a block of days, in crypto
          through CoinPay; nothing renews by itself.
        </p>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <section className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <h2 className="text-lg font-semibold">Free</h2>
            <p className="mt-1 text-3xl font-bold">$0</p>
            <ul className="mt-4 flex-1 space-y-2 text-sm text-zinc-300">
              <li>Research terminal at b1dz.com/terminal, the TUI and the CLI</li>
              <li>All quotes and charts, free and unmetered</li>
              <li>AI analyst: {cfg.freeDailyQueries} questions a day, under a monthly cap, answers marked as free</li>
            </ul>
            <div className="mt-5">
              {signedIn ? <Link href="/terminal" className="inline-block w-full rounded-lg border border-zinc-700 px-4 py-2 text-center text-sm font-semibold hover:border-zinc-500">Open the terminal</Link> : <Link href="/signup" className="inline-block w-full rounded-lg border border-zinc-700 px-4 py-2 text-center text-sm font-semibold hover:border-zinc-500">Create a free account</Link>}
            </div>
          </section>

          <section className="flex flex-col rounded-xl border border-orange-700/60 bg-zinc-900/60 p-5">
            <h2 className="text-lg font-semibold">Pro, 30 days</h2>
            <p className="mt-1 text-3xl font-bold">{money(cfg.pro30PriceUsd)}</p>
            <ul className="mt-4 flex-1 space-y-2 text-sm text-zinc-300">
              <li>The AI analyst on the latest Claude Opus, no daily limit</li>
              <li>Fair use: up to {money(cfg.proMonthlyCapUsd)} of AI cost per calendar month, then it pauses until the 1st</li>
              <li>No watermark on answers</li>
              <li>Prepaid: adds 30 days to any Pro you already have</li>
            </ul>
            <div className="mt-5"><BuyButton product="pro-30" label={`Buy 30 days for ${money(cfg.pro30PriceUsd)}`} signedIn={signedIn} primary /></div>
          </section>

          <section className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <h2 className="text-lg font-semibold">Pro, 365 days</h2>
            <p className="mt-1 text-3xl font-bold">{money(cfg.pro365PriceUsd)}</p>
            <p className="text-xs text-zinc-500">about {money(Math.round(perMonth365 * 100) / 100)} a month</p>
            <ul className="mt-4 flex-1 space-y-2 text-sm text-zinc-300">
              <li>Everything in Pro for a year</li>
              <li>Same monthly fair-use cap of {money(cfg.proMonthlyCapUsd)} of AI cost</li>
              <li>Prepaid: adds 365 days</li>
            </ul>
            <div className="mt-5"><BuyButton product="pro-365" label={`Buy 365 days for ${money(cfg.pro365PriceUsd)}`} signedIn={signedIn} /></div>
          </section>
        </div>

        <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h2 className="text-lg font-semibold">Profullstack Pass</h2>
          <p className="mt-2 text-sm text-zinc-300">
            A Profullstack Pass counts as b1dz Pro, with the same monthly cap, until it expires. Get one at{' '}
            <a href="https://coinpayportal.com/pass" className="text-orange-400 underline hover:text-orange-300">coinpayportal.com/pass</a>, then sign in with CoinPay
            or connect CoinPay in <Link href="/settings" className="underline">Settings</Link>. Credit codes and invite bonuses add Pro days too.
          </p>
        </section>

        <section className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h2 className="text-lg font-semibold">Agents and the API</h2>
          <p className="mt-2 text-sm text-zinc-300">
            Agents using the HTTP API (<code className="text-zinc-400">/api/research</code>) or the MCP server (<code className="text-zinc-400">/api/agent/mcp</code>) pay per call in USDC:
          </p>
          <ul className="mt-3 space-y-1 text-sm text-zinc-300">
            <li><span className="font-mono">{money(cfg.cardPriceUsd)}</span> per metered research card: derived analytics (risk statistics, dealer gamma, correlations, bond pricing...) and FRED and EIA data</li>
            <li><span className="font-mono">{money(cfg.analystPriceUsd)}</span> per AI analyst query</li>
            <li>Free: every quote, price history, chart, option chain and order book, and every other card. We never charge for raw market quotes.</li>
          </ul>
          <p className="mt-3 text-sm text-zinc-400">
            Pay per call with x402 (USDC on Base, Polygon or Ethereum, settled by CoinPay): a metered call without payment answers HTTP 402 with the offer.
            Or buy prepaid agent credit for your account and calls from your agent tokens draw on it.
          </p>
          <div className="mt-4 grid max-w-md gap-3 sm:grid-cols-2">
            <BuyButton product="agent-credit-10" label="$10 agent credit" signedIn={signedIn} />
            <BuyButton product="agent-credit-50" label="$50 agent credit" signedIn={signedIn} />
          </div>
        </section>

        <p className="mt-8 text-xs text-zinc-500">
          Payments go through CoinPay (any supported coin). Prices in US dollars. Research only, not investment advice.
        </p>
      </div>
    </main>
  );
}
