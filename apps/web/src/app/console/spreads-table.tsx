'use client';

import type { ArbState } from '@/lib/source-state-types';
import { pinPair } from '@/lib/chart-pinner';

interface Props {
  arb: ArbState | null;
}

type SpreadStatus = {
  text: string;
  className: string;
};

function spreadStatus(s: NonNullable<ArbState['spreads']>[number]): SpreadStatus {
  if (s.liqLabel && s.profitable && s.liqStatus && s.liqStatus.kind !== 'already-funded' && s.liqStatus.kind !== 'disabled') {
    const k = s.liqStatus.kind;
    const cls = k === 'liquidate' ? 'text-emerald-400'
      : k === 'cooldown' ? 'text-yellow-400'
      : 'text-zinc-300';
    return { text: s.liqLabel, className: cls };
  }
  if (s.seedLabel && s.profitable) {
    const k = s.seedStatus?.kind;
    const cls = k === 'seed' || k === 'inventory-ready' ? 'text-emerald-400'
      : k === 'cooldown' || k === 'paused' || k === 'budget-pair-exhausted' || k === 'budget-global-exhausted' ? 'text-yellow-400'
      : 'text-zinc-300';
    return { text: s.seedLabel, className: cls };
  }
  return s.profitable
    ? { text: '✓ PROFIT', className: 'text-emerald-400' }
    : { text: 'below fees', className: 'text-zinc-400' };
}

export function SpreadsTable({ arb }: Props) {
  const spreads = (arb?.spreads ?? [])
    .filter((s) => s?.pair && Number.isFinite(s.spread))
    .slice()
    .sort((a, b) => {
      if (a.profitable !== b.profitable) return a.profitable ? -1 : 1;
      return (b.spread ?? 0) - (a.spread ?? 0);
    });

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/80">
      <header className="border-b border-zinc-800 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
        Arb Spreads
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-3 py-2">Pair</th>
              <th className="px-3 py-2 text-right">Spread</th>
              <th className="px-3 py-2">Buy</th>
              <th className="px-3 py-2">Sell</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {spreads.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-zinc-500">
                  No spreads yet — daemon scanning.
                </td>
              </tr>
            )}
            {spreads.slice(0, 30).map((s, i) => {
              const status = spreadStatus(s);
              const spread = s.spread ?? 0;
              return (
                <tr
                  key={`${s.pair}-${i}`}
                  className="border-t border-zinc-800/60 cursor-pointer hover:bg-zinc-800/40"
                  onClick={() => pinPair(s.pair, s.buyExchange ?? null)}
                  title="Open in chart"
                >
                  <td className="px-3 py-1.5 text-zinc-200 underline decoration-dotted decoration-zinc-700">{s.pair}</td>
                  <td className={`px-3 py-1.5 text-right ${s.profitable ? 'text-emerald-400' : 'text-zinc-300'}`}>{spread.toFixed(4)}%</td>
                  <td
                    className="px-3 py-1.5 text-zinc-400 hover:text-zinc-200"
                    onClick={(e) => { e.stopPropagation(); if (s.buyExchange) pinPair(s.pair, s.buyExchange); }}
                  >
                    {s.buyExchange ?? '-'}
                  </td>
                  <td
                    className="px-3 py-1.5 text-zinc-400 hover:text-zinc-200"
                    onClick={(e) => { e.stopPropagation(); if (s.sellExchange) pinPair(s.pair, s.sellExchange); }}
                  >
                    {s.sellExchange ?? '-'}
                  </td>
                  <td className={`px-3 py-1.5 ${status.className}`}>{status.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
