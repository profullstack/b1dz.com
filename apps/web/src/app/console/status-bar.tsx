'use client';

import { useState } from 'react';
import { computeStatusFreshness, toneColor } from '@/lib/status-freshness';
import { putUiSettings } from '@/lib/use-source-state';
import type { ArbState, TradeState, UiSettings } from '@/lib/source-state-types';

interface Props {
  arb: ArbState | null;
  trade: TradeState | null;
  settings: UiSettings | null;
  loading: boolean;
  onMutate: () => void;
}

export function StatusBar({ arb, trade, settings, loading, onMutate }: Props) {
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
  const tradeDataLoading = trade == null || ts == null;

  const fresh = computeStatusFreshness({
    dataLoading: tradeDataLoading,
    lastTickMs: tradeLastTickMs,
    nowMs: Date.now(),
    realizedPnl,
    realizedPnlPct,
    totalFees,
    unrealizedPnl: unrealizedPnlSum,
    unrealizedPnlPct,
    hasOpenPositions: unrealizedCount > 0,
  });

  const arbLastTickMs = arb?.daemon?.lastTickAt ? new Date(arb.daemon.lastTickAt).getTime() : 0;
  const daemonOnline = arbLastTickMs > 0 && (Date.now() - arbLastTickMs) < 10_000;
  const daemonVer = arb?.daemon?.version ?? trade?.daemon?.version ?? '?';

  const daemonLimitPct = ts?.dailyLossLimitPct ?? 5;
  const tradingEnabled = settings?.tradingEnabled ?? null;

  const posStr = visiblePositions.length === 0
    ? 'no position'
    : visiblePositions.length === 1
      ? `${visiblePositions[0].exchange}:${visiblePositions[0].pair}`
      : `${visiblePositions.length} positions`;

  const [busy, setBusy] = useState(false);
  const toggleTrading = async () => {
    if (busy) return;
    setBusy(true);
    const next = tradingEnabled === true ? false : true;
    const ok = await putUiSettings({
      tradingEnabled: next,
      dailyLossLimitPct: settings?.dailyLossLimitPct ?? daemonLimitPct,
    });
    setBusy(false);
    if (ok) onMutate();
  };

  const adjustLimit = async (delta: number) => {
    if (busy) return;
    setBusy(true);
    const current = settings?.dailyLossLimitPct ?? daemonLimitPct;
    const next = Math.max(1, Math.min(100, Math.round((current + delta) * 10) / 10));
    const ok = await putUiSettings({
      tradingEnabled: tradingEnabled,
      dailyLossLimitPct: next,
    });
    setBusy(false);
    if (ok) onMutate();
  };

  return (
    <div className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2 font-mono text-xs">
        <span className="text-zinc-300">b1dz</span>
        <span className="text-zinc-500">daemon:v{daemonVer}</span>
        <span className={`flex items-center gap-1 ${daemonOnline ? 'text-emerald-400' : 'text-red-400'}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${daemonOnline ? 'bg-emerald-400' : 'bg-red-400'}`} />
          {daemonOnline ? 'online' : 'offline'}
        </span>
        <span className={visiblePositions.length === 0 ? 'text-zinc-400' : 'text-cyan-400'}>{posStr}</span>

        <span className="text-zinc-500">today:</span>
        <span className={toneColor(fresh.pnlTone)}>
          {fresh.pnlText}
          {fresh.pnlPctText && <span className="ml-1 opacity-80">({fresh.pnlPctText})</span>}
        </span>

        {fresh.unrealizedText && (
          <>
            <span className="text-zinc-500">open:</span>
            <span className={toneColor(fresh.unrealizedTone)}>
              {fresh.unrealizedText}
              {fresh.unrealizedPctText && <span className="ml-1 opacity-80">({fresh.unrealizedPctText})</span>}
            </span>
          </>
        )}

        <span className="text-zinc-500">fees:</span>
        <span className="text-zinc-200">{fresh.feesText}</span>

        {ts?.dailyLossLimitHit ? (
          <span className="rounded bg-yellow-500 px-2 py-0.5 font-semibold text-black">
            HALTED {daemonLimitPct.toFixed(1)}% daily limit
          </span>
        ) : (
          <span className="text-zinc-500">daily-limit:{daemonLimitPct.toFixed(1)}%</span>
        )}

        {fresh.isLoading && (
          <span className="rounded bg-white px-2 py-0.5 text-black">loading…</span>
        )}
        {fresh.isStale && (
          <span className="rounded bg-yellow-400 px-2 py-0.5 text-black">stale {fresh.staleSec}s</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => adjustLimit(-1)}
            disabled={busy || loading}
            className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            −1%
          </button>
          <button
            type="button"
            onClick={() => adjustLimit(+1)}
            disabled={busy || loading}
            className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            +1%
          </button>
          <button
            type="button"
            onClick={toggleTrading}
            disabled={busy}
            className={`rounded px-3 py-0.5 font-semibold ${
              tradingEnabled === true
                ? 'bg-emerald-500 text-black hover:bg-emerald-400'
                : tradingEnabled === false
                  ? 'bg-red-600 text-white hover:bg-red-500'
                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
            } disabled:opacity-50`}
          >
            {tradingEnabled === true ? 'TRADING: ENABLED' : tradingEnabled === false ? 'TRADING: DISABLED' : 'TRADING: ?'}
          </button>
        </div>
      </div>
    </div>
  );
}
