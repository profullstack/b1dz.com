'use client';

import type { PumpfunState } from '@/lib/source-state-types';

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
              <th className="px-3 py-2 text-right">SOL spent</th>
              <th className="px-3 py-2 text-right">Tokens</th>
              <th className="px-3 py-2 text-right">Age</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-zinc-500">
                  No open pump.fun positions
                </td>
              </tr>
            )}
            {positions.map((p, i) => (
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
                  ${p.entryMarketCapUsd.toFixed(0)}
                </td>
                <td className="px-3 py-1.5 text-right text-zinc-300">
                  {p.solSpent.toFixed(4)}
                </td>
                <td className="px-3 py-1.5 text-right text-zinc-300">
                  {p.tokenBalance ? p.tokenBalance.toLocaleString() : '-'}
                </td>
                <td className="px-3 py-1.5 text-right text-zinc-400">
                  {fmtAge(p.entryAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
