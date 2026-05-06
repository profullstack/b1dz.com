'use client';

import { useState } from 'react';
import { Sparkline } from '@/components/sparkline';
import type { PumpfunState } from '@/lib/source-state-types';
import { requestPumpfunSell } from '@/lib/use-source-state';

interface Props {
  pumpfun: PumpfunState | null;
}

function fmtAge(entryAt: number): string {
  const ms = Date.now() - entryAt;
  if (ms < 0 || !Number.isFinite(ms)) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function shortMint(mint: string): string {
  if (mint.length <= 12) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function PumpfunPanel({ pumpfun }: Props) {
  const positions = pumpfun?.positions ?? [];
  const enabled = pumpfun?.enabled ?? false;
  const status = pumpfun?.daemon?.status ?? '-';
  const solUsdRef = pumpfun?.solUsdRef ?? 0;
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const onSell = async (mint: string) => {
    setPending((p) => ({ ...p, [mint]: true }));
    try {
      await requestPumpfunSell(mint);
    } finally {
      setPending((p) => ({ ...p, [mint]: false }));
    }
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/80">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Pump.fun positions
        </span>
        <span className="font-mono text-[10px] text-zinc-500">
          {enabled ? 'enabled' : 'disabled'} · {status} · {positions.length} open
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-3 py-2">Symbol</th>
              <th className="px-3 py-2">Mint</th>
              <th className="px-3 py-2 text-right">Entry MCAP</th>
              <th className="px-3 py-2 text-right">Now MCAP</th>
              <th className="px-3 py-2 text-right">PnL</th>
              <th className="px-3 py-2 text-right">SOL spent</th>
              <th className="px-3 py-2 text-right">Age</th>
              <th className="px-3 py-2 text-center">Chart</th>
              <th className="px-3 py-2 text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-3 text-zinc-500">
                  No open pump.fun positions
                </td>
              </tr>
            )}
            {positions.map((p, i) => {
              const entry = Number.isFinite(p.entryMarketCapUsd) ? p.entryMarketCapUsd : 0;
              const now = Number.isFinite(p.currentMarketCapUsd) ? (p.currentMarketCapUsd as number) : 0;
              const havePnl = entry > 0 && now > 0;
              const pnlPct = havePnl ? ((now - entry) / entry) * 100 : 0;
              // Approximate USD P&L. solSpent is constant; the bonding-curve
              // ratio gives us the position's value vs cost in SOL terms;
              // multiplying by the worker's solUsdRef converts to USD.
              const usdSpent = solUsdRef > 0 ? p.solSpent * solUsdRef : 0;
              const pnlUsdApprox = havePnl && usdSpent > 0 ? usdSpent * (pnlPct / 100) : 0;
              const pnlClass = pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';

              return (
                <tr
                  key={`${p.mint}-${i}`}
                  className="border-t border-zinc-800/60"
                >
                  <td className="px-3 py-1.5 text-emerald-400">{p.symbol ?? '-'}</td>
                  <td className="px-3 py-1.5 text-zinc-400" title={p.mint}>
                    <a
                      href={`https://pump.fun/coin/${p.mint}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-dotted decoration-zinc-700 hover:text-zinc-200"
                    >
                      {shortMint(p.mint)}
                    </a>
                  </td>
                  <td className="px-3 py-1.5 text-right text-zinc-300">
                    ${entry.toFixed(0)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-zinc-300">
                    {now > 0 ? `$${now.toFixed(0)}` : '—'}
                  </td>
                  <td className={`px-3 py-1.5 text-right ${havePnl ? pnlClass : 'text-zinc-500'}`}>
                    {havePnl
                      ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`
                      : '—'}
                    {havePnl && usdSpent > 0
                      ? ` ($${pnlUsdApprox.toFixed(2)})`
                      : ''}
                  </td>
                  <td className="px-3 py-1.5 text-right text-zinc-300">
                    {p.solSpent.toFixed(4)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-zinc-400">
                    {fmtAge(p.entryAt)}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <Sparkline samples={p.mcapSamples} profitable={pnlPct >= 0} />
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <button
                      type="button"
                      onClick={() => onSell(p.mint)}
                      disabled={!!pending[p.mint]}
                      className="rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-red-300 hover:bg-red-500/20 disabled:opacity-50"
                      title="Force-sell this position on the next worker tick"
                    >
                      {pending[p.mint] ? 'queued…' : 'sell now'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
