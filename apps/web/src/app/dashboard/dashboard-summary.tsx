'use client';

import Link from 'next/link';
import { useSourceState } from '@/lib/use-source-state';
import { computeStatusFreshness, toneColor } from '@/lib/status-freshness';

export function DashboardSummary() {
  const { arb, trade, loading } = useSourceState();
  const ts = trade?.tradeStatus;
  const positions = ts?.positions ?? (ts?.position ? [{ exchange: 'kraken', ...ts.position }] : []);
  const visiblePositions = positions.filter((p) => ((p.currentPrice ?? 0) * (p.volume ?? 0)) >= 1);

  const realizedPnl = ts?.dailyPnl ?? 0;
  const realizedPnlPct = ts?.dailyPnlPct ?? 0;
  const closedTrades = trade?.tradeState?.closedTrades ?? [];
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const closedTradeFees = closedTrades
    .filter((t) => t.exitTime >= todayMs)
    .reduce((sum, t) => sum + (Number.isFinite(t.fee) ? t.fee : 0), 0);
  const totalFees = typeof ts?.dailyFees === 'number' && Number.isFinite(ts.dailyFees)
    ? ts.dailyFees
    : closedTradeFees;

  let unrealizedPnlSum = 0;
  let unrealizedNotional = 0;
  let unrealizedCount = 0;
  for (const pos of positions) {
    const entry = Number.isFinite(pos.entryPrice) ? pos.entryPrice : 0;
    const pnl = Number.isFinite(pos.pnlUsd) ? pos.pnlUsd : 0;
    const vol = Number.isFinite(pos.volume) ? pos.volume : 0;
    if (entry <= 0 || vol <= 0) continue;
    unrealizedPnlSum += pnl;
    unrealizedNotional += entry * vol;
    unrealizedCount += 1;
  }
  const unrealizedPnlPct = unrealizedNotional > 0 ? (unrealizedPnlSum / unrealizedNotional) * 100 : 0;

  const tradeLastTickMs = trade?.daemon?.lastTickAt
    ? new Date(trade.daemon.lastTickAt).getTime()
    : null;
  const dataLoading = loading || trade == null || ts == null;

  const fresh = computeStatusFreshness({
    dataLoading,
    lastTickMs: tradeLastTickMs,
    nowMs: Date.now(),
    realizedPnl,
    realizedPnlPct,
    totalFees,
    unrealizedPnl: unrealizedPnlSum,
    unrealizedPnlPct,
    hasOpenPositions: unrealizedCount > 0,
  });

  const arbLastMs = arb?.daemon?.lastTickAt ? new Date(arb.daemon.lastTickAt).getTime() : 0;
  const daemonOnline = arbLastMs > 0 && Date.now() - arbLastMs < 10_000;
  const profitableSpreads = (arb?.spreads ?? []).filter((s) => s.profitable).length;

  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Today PnL" tone={fresh.pnlTone}>
        <span className={toneColor(fresh.pnlTone)}>{fresh.pnlText}</span>
        {fresh.pnlPctText && (
          <span className={`ml-2 text-sm ${toneColor(fresh.pnlTone)} opacity-80`}>({fresh.pnlPctText})</span>
        )}
      </Card>
      <Card label="Open PnL" tone={fresh.unrealizedTone}>
        {fresh.unrealizedText ? (
          <>
            <span className={toneColor(fresh.unrealizedTone)}>{fresh.unrealizedText}</span>
            {fresh.unrealizedPctText && (
              <span className={`ml-2 text-sm ${toneColor(fresh.unrealizedTone)} opacity-80`}>({fresh.unrealizedPctText})</span>
            )}
          </>
        ) : (
          <span className="text-zinc-500">—</span>
        )}
      </Card>
      <Card label="Fees today">
        <span className="text-zinc-100">{fresh.feesText}</span>
      </Card>
      <Card label="Open positions">
        <span className="text-zinc-100">{visiblePositions.length}</span>
      </Card>
      <Card label="Profitable spreads">
        <span className="text-zinc-100">{profitableSpreads}</span>
      </Card>
      <Card label="Daemon">
        <span className={`flex items-center gap-2 ${daemonOnline ? 'text-emerald-400' : 'text-red-400'}`}>
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${daemonOnline ? 'bg-emerald-400' : 'bg-red-400'}`} />
          {daemonOnline ? 'online' : 'offline'}
        </span>
      </Card>
      <div className="sm:col-span-2 flex">
        <Link
          href="/console"
          className="flex w-full items-center justify-center rounded-2xl border border-orange-500/40 bg-gradient-to-r from-orange-500/15 to-amber-500/10 px-6 py-5 text-center text-base font-semibold text-orange-300 transition hover:border-orange-400 hover:from-orange-500/25 hover:to-amber-500/20"
        >
          Open Console →
        </Link>
      </div>
    </section>
  );
}

function Card({ label, children, tone: _tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
      <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{children}</div>
    </div>
  );
}
