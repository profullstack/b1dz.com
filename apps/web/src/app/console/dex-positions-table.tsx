'use client';

import { formatUsdPrice } from './format';
import type { TradeState } from '@/lib/source-state-types';
import { Sparkline } from '@/components/sparkline';
import { pinPair } from '@/lib/chart-pinner';

interface Props {
  trade: TradeState | null;
}

const DEX_EXCHANGES = new Set(['uniswap-v3', 'jupiter']);

export function DexPositionsTable({ trade }: Props) {
  const ts = trade?.tradeStatus;
  const all = ts?.positions ?? [];
  const dex = all.filter((p) => DEX_EXCHANGES.has(p.exchange));
  const visible = dex.filter((p) => ((p.currentPrice ?? 0) * (p.volume ?? 0)) >= 1);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/80">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          DEX positions
        </span>
        <span className="font-mono text-[10px] text-zinc-500">
          uniswap-v3 · jupiter · {visible.length} open
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-3 py-2">Venue</th>
              <th className="px-3 py-2">Pair</th>
              <th className="px-3 py-2 text-right">Coins</th>
              <th className="px-3 py-2 text-right">Value</th>
              <th className="px-3 py-2 text-right">Entry</th>
              <th className="px-3 py-2 text-right">Last</th>
              <th className="px-3 py-2 text-right">PnL</th>
              <th className="px-3 py-2 text-right">Stop</th>
              <th className="px-3 py-2 text-right">Age</th>
              <th className="px-3 py-2 text-center">Chart</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-3 text-zinc-500">
                  No open DEX positions
                </td>
              </tr>
            )}
            {visible.map((p, i) => {
              const volume = Number.isFinite(p.volume) ? p.volume : 0;
              const last = Number.isFinite(p.currentPrice) ? p.currentPrice : 0;
              const value = volume * last;
              const entry = Number.isFinite(p.entryPrice) ? p.entryPrice : 0;
              const pnlPct = Number.isFinite(p.pnlPct) ? p.pnlPct : 0;
              const pnlUsd = Number.isFinite(p.pnlUsd) ? p.pnlUsd : 0;
              const stop = Number.isFinite(p.stopPrice) ? p.stopPrice : 0;
              const pnlClass = pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
              const exClass = p.exchange === 'uniswap-v3' ? 'text-pink-400' : 'text-emerald-300';
              return (
                <tr
                  key={`${p.exchange}-${p.pair}-${i}`}
                  className="border-t border-zinc-800/60 cursor-pointer hover:bg-zinc-800/40"
                  onClick={() => pinPair(p.pair, p.exchange)}
                  title="Open in chart"
                >
                  <td className={`px-3 py-1.5 ${exClass}`}>{p.exchange}</td>
                  <td className="px-3 py-1.5 text-zinc-200">
                    <span className="underline decoration-dotted decoration-zinc-700">{p.pair}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right text-zinc-300">{volume.toFixed(6)}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-300">${value.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-300">{entry > 0 ? `$${formatUsdPrice(entry)}` : '-'}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-300">${formatUsdPrice(last)}</td>
                  <td className={`px-3 py-1.5 text-right ${pnlClass}`}>
                    {entry > 0 ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})` : '-'}
                  </td>
                  <td className="px-3 py-1.5 text-right text-zinc-300">{stop > 0 ? `$${formatUsdPrice(stop)}` : '-'}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-400">{p.elapsed ?? '-'}</td>
                  <td className="px-3 py-1.5 text-center">
                    <Sparkline samples={p.priceSamples} profitable={pnlUsd >= 0} />
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
