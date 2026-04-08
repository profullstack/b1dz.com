import { createServerSupabase } from '@/lib/supabase';
import type { Opportunity } from '@b1dz/core';
import { score } from '@b1dz/core';

async function getOpportunities(): Promise<Opportunity[]> {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from('opportunities')
    .select('payload')
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) {
    console.error('opps fetch failed:', error.message);
    return [];
  }
  const opps = (data ?? []).map((r) => r.payload as Opportunity);
  return opps.sort((a, b) => score(b) - score(a));
}

async function getUserEmail(): Promise<string | null> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.email ?? null;
}

export default async function Home() {
  const [opps, email] = await Promise.all([getOpportunities(), getUserEmail()]);
  return (
    <main className="max-w-6xl mx-auto p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">b1dz</h1>
          <p className="text-sm text-zinc-400">Multi-source profit monitor</p>
        </div>
        <div className="text-xs text-zinc-500">{email}</div>
      </header>

      <section>
        <h2 className="text-lg font-semibold mb-3">Top opportunities</h2>
        {opps.length === 0 ? (
          <p className="text-zinc-500 text-sm">No opportunities yet — start a source from the CLI.</p>
        ) : (
          <ul className="space-y-2">
            {opps.map((o) => (
              <li key={o.id} className="rounded-lg border border-zinc-800 p-3 flex items-center justify-between">
                <div>
                  <div className="text-sm text-zinc-400">{o.sourceId} · {o.category ?? '—'}</div>
                  <div className="font-medium">{o.title}</div>
                </div>
                <div className="text-right">
                  <div className={o.projectedProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {o.projectedProfit >= 0 ? '+' : '-'}${Math.abs(o.projectedProfit).toFixed(2)}
                  </div>
                  <div className="text-xs text-zinc-500">cost ${o.costNow.toFixed(2)} · conf {(o.confidence * 100).toFixed(0)}%</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
