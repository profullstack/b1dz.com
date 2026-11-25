'use client';

import { useEffect, useState } from 'react';

interface Status {
  tier: 'pro' | 'free';
  via: 'pro_days' | 'pass' | null;
  proUntil: string | null;
  passUntil: string | null;
  analyst: { monthCostUsd: number; monthCapUsd: number; todayQueries: number; dailyQueries: number | null };
  agentCreditUsd: number;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

/** Settings -> Plan: Pro or free, analyst allowance used, agent credit. */
export function ProCard() {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    fetch('/api/billing/status').then((r) => (r.ok ? r.json() : null)).then(setS, () => setS(null));
  }, []);
  if (!s) return null;
  const pct = s.analyst.monthCapUsd > 0 ? Math.min(100, Math.round((s.analyst.monthCostUsd / s.analyst.monthCapUsd) * 100)) : 0;
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">Plan: {s.tier === 'pro' ? 'Pro' : 'Free'}</h2>
        <a href="/pricing" className="text-xs text-orange-400 hover:text-orange-300">{s.tier === 'pro' ? 'Extend Pro' : 'Get Pro'}</a>
      </div>
      <p className="mt-2 text-xs text-zinc-400">
        {s.tier === 'pro'
          ? s.via === 'pass'
            ? `Pro through your Profullstack Pass until ${day(s.passUntil)}.`
            : `Pro until ${day(s.proUntil)}.${s.passUntil ? ` Profullstack Pass until ${day(s.passUntil)}.` : ''}`
          : `AI analyst: ${s.analyst.todayQueries} of ${s.analyst.dailyQueries ?? 0} free questions used today.`}
        {' '}This month&apos;s analyst allowance: {pct}% used.
        {s.agentCreditUsd > 0 ? ` Agent credit: $${s.agentCreditUsd.toFixed(2)}.` : ''}
      </p>
    </section>
  );
}
