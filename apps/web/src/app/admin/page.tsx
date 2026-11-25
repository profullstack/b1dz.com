import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase';
import { isAdminUser } from '@/lib/monetization';
import { loadMetrics } from '@/lib/metrics';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'b1dz admin: monetization test', robots: { index: false } };

const usd = (n: number) => `$${n.toFixed(2)}`;

function Row({ label, value, red, hint }: { label: string; value: string; red?: boolean; hint?: string }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 border-b border-zinc-800 py-2 ${red ? 'text-red-400' : ''}`}>
      <span className="text-sm text-zinc-400">{label}{hint ? <span className="ml-2 text-xs text-zinc-600">{hint}</span> : null}</span>
      <span className="font-mono text-sm">{value}{red ? '  RED' : ''}</span>
    </div>
  );
}

export default async function AdminPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/admin');
  if (!isAdminUser(user.id)) notFound();
  const { config: cfg, metrics: m, verdict: v, notes, activePasses, windowStart } = await loadMetrics(createAdminSupabase());

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-bold">Monetization test</h1>
          <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-300">settings</Link>
        </div>
        <p className="mb-6 text-sm text-zinc-400">
          60-day test {cfg.testStart} to {cfg.testEnd}. Trailing 30 days from {windowStart.slice(0, 10)}. Revisit if AI cost per non-paying
          user passes {usd(cfg.maxAiCostPerFreeUserUsd)}/month, founder time goes above 3 hours a week, or prepaid renewals fall short of
          Anthropic plus server cost.
        </p>

        <h2 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-zinc-500">AI cost (Anthropic)</h2>
        <Row label="AI cost per non-paying user" hint={`${m.freeActiveUsers} free users asked`} value={usd(v.costPerFreeUser)} red={v.freeCostRed} />
        <Row label="Free analyst cost" value={usd(m.freeAiCostUsd)} />
        <Row label="Pro analyst cost" value={usd(m.proAiCostUsd)} />
        <Row label="Agent analyst cost" value={usd(m.agentAiCostUsd)} />
        <Row label="Total AI cost" value={usd(v.totalAiCost)} />
        <Row label="Server cost (B1DZ_SERVER_MONTHLY_USD)" value={usd(cfg.serverMonthlyUsd)} />

        <h2 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-zinc-500">Revenue</h2>
        <Row label="Prepaid Pro (CoinPay)" hint={`${m.proBuyers} buyers`} value={usd(m.proRevenueUsd)} red={v.revenueRed} />
        <Row label="Renewals (repeat Pro purchases)" value={String(m.renewals)} />
        <Row label="Agent x402 revenue" value={usd(m.x402RevenueUsd)} />
        <Row label="Agent prepaid credit sold" hint={`${usd(m.prepaidSpendUsd)} drawn`} value={usd(m.agentCreditRevenueUsd)} />
        <Row label="Active Profullstack Passes (connected)" value={String(activePasses)} />
        <Row label="All revenue vs AI + server cost" value={`${usd(v.revenue)} vs ${usd(v.cost)}`} red={v.allRevenueRed} />

        <h2 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-zinc-500">Founder time</h2>
        <p className="mb-3 text-sm text-zinc-400">Not measurable here. Note the hours each week; above 3 hours a week is a revisit trigger.</p>
        <form action="/api/admin/notes" method="post" className="flex gap-2">
          <input name="note" required maxLength={2000} placeholder="e.g. week of 12-01: 2.5 h" className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm" />
          <button className="rounded bg-orange-600 px-3 py-2 text-sm font-semibold hover:bg-orange-500">Add</button>
        </form>
        <ul className="mt-3 space-y-1 text-sm text-zinc-300">
          {notes.map((n) => (
            <li key={n.at}><span className="mr-2 font-mono text-xs text-zinc-500">{n.at.slice(0, 10)}</span>{n.note}</li>
          ))}
        </ul>
      </div>
    </main>
  );
}
