'use client';

/**
 * Ask the AI analyst about the tab on screen. The cards shown (at most 4) go
 * along as context; the answer names the cards and sources it used. Free
 * accounts see their daily allowance and a watermark line; Pro answers stop
 * at the monthly cap with a plain message (POST /api/research/analyst).
 */
import Link from 'next/link';
import { useState } from 'react';

interface Source {
  id: string;
  title: string;
  source: string;
  asOf?: string;
}
interface Answer {
  answer: string;
  tier: 'pro' | 'free';
  sources: Source[];
  allowance?: { todayQueries?: number; dailyQueries?: number; monthCostUsd: number; monthCapUsd: number };
}

export function AnalystBox({ cards, signedIn, loginHref }: { cards: { id: string; params: Record<string, string> }[]; signedIn: boolean; loginHref: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Answer | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const ask = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/research/analyst', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q.trim(), cards: cards.slice(0, 4) }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error ?? `the analyst failed (${r.status})`);
      setRes(b as Answer);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mb-3 rounded border border-cyan-500/40 px-2 py-1 text-cyan-300 hover:bg-cyan-500/10">
        ask the AI analyst about this tab
      </button>
    );
  }
  return (
    <div className="mb-3 rounded border border-cyan-500/40 bg-zinc-950 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-cyan-300">AI analyst</span>
        <button type="button" onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-200" aria-label="Close analyst">
          ×
        </button>
      </div>
      {!signedIn ? (
        <p className="text-zinc-400">
          <Link href={loginHref} className="underline">Sign in</Link> to ask. Free accounts get a few questions a day; <Link href="/pricing" className="underline">Pro</Link> answers more.
        </p>
      ) : (
        <>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={2000}
              placeholder="e.g. what stands out here, and what would change the picture?"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 placeholder:text-zinc-600 focus:border-cyan-400 focus:outline-none"
            />
            <button type="submit" disabled={busy || !q.trim()} className="whitespace-nowrap rounded border border-cyan-500/60 px-2 py-1 text-cyan-300 disabled:opacity-50">
              {busy ? 'thinking…' : 'ask'}
            </button>
          </form>
          {err && (
            <p className="mt-2 text-amber-300">
              {err} {/pricing/.test(err) ? null : <Link href="/pricing" className="underline">Plans</Link>}
            </p>
          )}
          {res && (
            <div className="mt-3 whitespace-pre-wrap text-zinc-200">
              {res.answer}
              {res.sources.length > 0 && (
                <div className="mt-2 text-xs text-zinc-500">From: {res.sources.map((s) => `${s.title} (${s.source}${s.asOf ? `, ${s.asOf}` : ''})`).join('; ')}</div>
              )}
              {res.tier === 'free' && res.allowance?.dailyQueries != null && (
                <div className="mt-1 text-xs text-zinc-500">
                  {res.allowance.todayQueries} of {res.allowance.dailyQueries} free questions used today.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
