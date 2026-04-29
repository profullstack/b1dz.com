'use client';

import { useMemo, useState } from 'react';
import { formatLogTs } from './format';
import type { ArbPipelineState, ArbState, TradeState } from '@/lib/source-state-types';

interface Props {
  arb: ArbState | null;
  trade: TradeState | null;
  pipeline: ArbPipelineState | null;
}

type TabId = 'activity' | 'pipeline' | 'logs';
const PAGE_SIZE = 20;

interface ActivityRow {
  at: string;
  text: string;
  className: string;
}

function activityClass(text: string, raw: boolean): string {
  if (raw) {
    if (text.includes('✗') || text.includes('error') || text.includes('FAILED')) return 'text-red-400';
    if (text.includes('[ws]')) return 'text-cyan-400';
    if (text.includes('[coinbase]') || text.includes('[binance]') || text.includes('[kraken]')) return 'text-yellow-400';
    if (text.includes('[trade]')) return 'text-emerald-400';
    if (text.includes('[arb]')) return 'text-blue-400';
    return 'text-zinc-300';
  }
  if (text.includes('BUY') || text.includes('✓') || text.includes('EXECUTED')) return 'text-emerald-400';
  if (text.includes('SELL') || text.includes('✗') || text.includes('SKIPPED')) return 'text-red-400';
  if (text.includes('SIGNAL') || text.includes('⚡') || text.includes('ENTRY')) return 'text-yellow-400';
  if (text.includes('[ws]')) return 'text-cyan-400';
  if (text.includes('[arb]')) return 'text-blue-400';
  return 'text-zinc-300';
}

export function FooterTabs({ arb, trade, pipeline }: Props) {
  const [tab, setTab] = useState<TabId>('activity');
  const [page, setPage] = useState(0);

  const activity = useMemo<ActivityRow[]>(() => {
    const arbLog = arb?.activityLog ?? [];
    const tradeLog = trade?.activityLog ?? [];
    const seen = new Set<string>();
    const merged = [...arbLog, ...tradeLog]
      .filter((l) => {
        if (!l?.at || !l?.text?.trim()) return false;
        const k = `${l.at}:${l.text}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => b.at.localeCompare(a.at));
    return merged.map((l) => ({ at: l.at, text: l.text, className: activityClass(l.text, false) }));
  }, [arb, trade]);

  const rawLogs = useMemo<ActivityRow[]>(() => {
    const arbRaw = arb?.rawLog ?? [];
    const tradeRaw = trade?.rawLog ?? [];
    return [...arbRaw, ...tradeRaw]
      .filter((l) => !!l?.at && !!l?.text?.trim())
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 600)
      .map((l) => ({ at: l.at, text: l.text, className: activityClass(l.text, true) }));
  }, [arb, trade]);

  const pipelineRows = useMemo(() => {
    const v = pipeline?.v2;
    if (!v) {
      return {
        header: 'arb pipeline not started',
        opportunities: [] as { ts: string; line: string; ok: boolean }[],
        decisions: [] as { ts: string; status: string; reason: string; count: number }[],
        circuit: 'unknown',
      };
    }
    const opportunities = v.recentOpportunities.slice(-30).reverse().map((o) => {
      const ts = o.observedAt ? new Date(o.observedAt).toLocaleTimeString('en-US', { hour12: false }) : '??:??:??';
      const netStr = `net=$${(o.expectedNetUsd ?? 0).toFixed(2)} ${(o.expectedNetBps ?? 0).toFixed(0)}bps`;
      let line: string;
      if (o.category === 'dex_triangular' && o.route?.hops?.length) {
        const path = o.route.hops.map((h) => h.tokenOut).join('→');
        const anchor = o.route.hops[0]?.tokenIn ?? '?';
        line = `TRI ${anchor}→${path} ${o.route.venue}@${o.route.chain ?? '?'} ${netStr}`;
      } else {
        const pair = o.buyQuote?.pair ?? o.asset ?? '?';
        line = `${pair} ${o.buyVenue ?? '?'}→${o.sellVenue ?? '?'} ${netStr}`;
      }
      return { ts, line, ok: o.executable };
    });

    type DRow = { ts: string; status: string; reason: string; count: number };
    const collapsed: DRow[] = [];
    for (const d of v.recentDecisions) {
      const ts = new Date(d.at).toLocaleTimeString('en-US', { hour12: false });
      const last = collapsed[collapsed.length - 1];
      if (last && last.status === d.status && last.reason === d.reason) {
        last.count++;
        last.ts = ts;
      } else {
        collapsed.push({ ts, status: d.status, reason: d.reason, count: 1 });
      }
    }
    const decisions = collapsed.slice(-20).reverse();

    return {
      header: `mode=${v.mode}  pairs=${v.pairs.length}  adapters=${v.adapters.join(',')}`,
      opportunities,
      decisions,
      circuit: v.circuit.state === 'closed' ? 'closed' : `OPEN ${v.circuit.trip?.reason ?? ''}`,
    };
  }, [pipeline]);

  const rows = tab === 'activity' ? activity : tab === 'logs' ? rawLogs : null;
  const totalPages = rows ? Math.max(1, Math.ceil(rows.length / PAGE_SIZE)) : 1;
  const safePage = Math.min(page, totalPages - 1);
  const pagedRows = rows ? rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE) : [];

  const switchTab = (id: TabId) => {
    setTab(id);
    setPage(0);
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/80">
      <header className="flex items-center justify-between border-b border-zinc-800 px-2 py-1">
        <div className="flex">
          {(['activity', 'pipeline', 'logs'] as TabId[]).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => switchTab(id)}
              className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider ${
                tab === id ? 'border-b-2 border-orange-400 text-orange-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {id === 'pipeline' ? 'Arb Pipeline' : id}
            </button>
          ))}
        </div>
        {rows && (
          <div className="flex items-center gap-2 px-2 text-xs text-zinc-500">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded border border-zinc-700 px-2 py-0.5 hover:border-zinc-500 disabled:opacity-30"
            >
              ←
            </button>
            <span>{safePage + 1}/{totalPages}</span>
            <button
              type="button"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="rounded border border-zinc-700 px-2 py-0.5 hover:border-zinc-500 disabled:opacity-30"
            >
              →
            </button>
          </div>
        )}
      </header>

      <div className="max-h-[400px] overflow-y-auto p-3 font-mono text-xs">
        {(tab === 'activity' || tab === 'logs') && (
          pagedRows.length === 0 ? (
            <p className="text-zinc-500">No entries.</p>
          ) : (
            <ul className="space-y-1">
              {pagedRows.map((r, i) => (
                <li key={`${tab}-${i}-${r.at}`} className="flex gap-3">
                  <span className="shrink-0 text-zinc-600">{formatLogTs(r.at)}</span>
                  <span className={r.className}>{r.text}</span>
                </li>
              ))}
            </ul>
          )
        )}

        {tab === 'pipeline' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-zinc-300">
              <span>{pipelineRows.header}</span>
              <span className={pipelineRows.circuit === 'closed' ? 'text-emerald-400' : 'text-red-400'}>
                circuit={pipelineRows.circuit}
              </span>
            </div>
            <div>
              <p className="mb-1 font-semibold text-zinc-300">Recent Opportunities</p>
              {pipelineRows.opportunities.length === 0 ? (
                <p className="text-zinc-500">No opportunities yet — scanning.</p>
              ) : (
                <ul className="space-y-1">
                  {pipelineRows.opportunities.slice(0, 15).map((o, i) => (
                    <li key={`opp-${i}`} className="flex gap-3">
                      <span className="shrink-0 text-zinc-600">{o.ts}</span>
                      <span className={o.ok ? 'text-emerald-400' : 'text-red-400'}>{o.ok ? '✓' : '✗'}</span>
                      <span className="text-zinc-300">{o.line}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1 font-semibold text-zinc-300">Recent Decisions</p>
              {pipelineRows.decisions.length === 0 ? (
                <p className="text-zinc-500">No decisions yet.</p>
              ) : (
                <ul className="space-y-1">
                  {pipelineRows.decisions.slice(0, 12).map((d, i) => {
                    const cls = d.status === 'filled' ? 'text-emerald-400' : d.status === 'rejected' ? 'text-red-400' : 'text-yellow-400';
                    return (
                      <li key={`dec-${i}`} className="flex gap-3">
                        <span className="shrink-0 text-zinc-600">{d.ts}</span>
                        <span className={cls}>{d.status}</span>
                        <span className="text-zinc-300">{d.reason}{d.count > 1 ? ` (×${d.count})` : ''}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
