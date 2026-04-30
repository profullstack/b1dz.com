'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useSourceState } from '@/lib/use-source-state';
import type { TradeState } from '@/lib/source-state-types';
import { Sparkline } from '@/components/sparkline';

type ClosedTrade = NonNullable<NonNullable<TradeState['tradeState']>['closedTrades']>[number];

const MAX_MONTHLY_GROWTH = 0.5;
const RISK_HAIRCUT = 0.8;

function buildProjection(bankroll: number, hourlyProfit: number, startMs: number, days: number) {
  const hr = bankroll > 0 ? hourlyProfit / bankroll : 0;
  const dailyRate = Math.pow(1 + hr, 24) - 1;
  const conservativeRate = Math.min(dailyRate, Math.pow(1 + MAX_MONTHLY_GROWTH, 1 / 30) - 1);
  const riskRate = dailyRate * RISK_HAIRCUT;
  const n = Math.min(days * 2, 400);

  const flat: LineData<UTCTimestamp>[] = [];
  const compounded: LineData<UTCTimestamp>[] = [];
  const conservative: LineData<UTCTimestamp>[] = [];
  const riskAdjusted: LineData<UTCTimestamp>[] = [];

  for (let i = 0; i <= n; i++) {
    const d = (days / n) * i;
    const time = Math.floor((startMs + d * 86_400_000) / 1000) as UTCTimestamp;
    flat.push({ time, value: Math.max(0, bankroll + hourlyProfit * d * 24) });
    compounded.push({ time, value: bankroll * Math.pow(1 + dailyRate, d) });
    conservative.push({ time, value: bankroll * Math.pow(1 + conservativeRate, d) });
    riskAdjusted.push({ time, value: bankroll * Math.pow(1 + riskRate, d) });
  }
  return { flat, compounded, conservative, riskAdjusted, dailyRate };
}

function buildReal(
  bankroll: number,
  trades: ClosedTrade[],
  startMs: number,
): LineData<UTCTimestamp>[] {
  const sorted = [...trades].filter((t) => t.exitTime >= startMs).sort((a, b) => a.exitTime - b.exitTime);
  const pts: LineData<UTCTimestamp>[] = [
    { time: Math.floor(startMs / 1000) as UTCTimestamp, value: bankroll },
  ];
  let cum = 0;
  for (const t of sorted) {
    cum += t.netPnl;
    pts.push({ time: Math.floor(t.exitTime / 1000) as UTCTimestamp, value: bankroll + cum });
  }
  return pts;
}

const FMT = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SIGN = (v: number) => (v >= 0 ? '+' : '');

const BREAKPOINTS = [
  { days: 1, label: '1 day' },
  { days: 7, label: '1 week' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
];

function fmtDate(ms: number) {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function fmtPrice(v: number) {
  if (!Number.isFinite(v)) return '—';
  return v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : v >= 1 ? v.toFixed(4)
    : v.toFixed(6);
}

// ─── P&L by period ────────────────────────────────────────────────

const PERIODS = [
  { label: '1 min',    ms: 60_000 },
  { label: '5 min',    ms: 5 * 60_000 },
  { label: '15 min',   ms: 15 * 60_000 },
  { label: '30 min',   ms: 30 * 60_000 },
  { label: '1 hour',   ms: 60 * 60_000 },
  { label: '1 day',    ms: 24 * 60 * 60_000 },
  { label: '1 week',   ms: 7 * 24 * 60 * 60_000 },
  { label: '1 month',  ms: 30 * 24 * 60 * 60_000 },
  { label: '3 months', ms: 90 * 24 * 60 * 60_000 },
  { label: '6 months', ms: 180 * 24 * 60 * 60_000 },
  { label: '1 year',   ms: 365 * 24 * 60 * 60_000 },
  { label: 'All time', ms: Infinity },
] as const;

function PnLBreakdown({ trades }: { trades: ClosedTrade[] }) {
  const now = Date.now();
  const rows = PERIODS.map(({ label, ms }) => {
    const bucket = trades.filter((t) => now - t.exitTime <= ms);
    if (bucket.length === 0) return { label, count: 0, gross: 0, fees: 0, net: 0, winRate: null };
    const gross = bucket.reduce((s, t) => s + t.grossPnl, 0);
    const fees  = bucket.reduce((s, t) => s + t.fee, 0);
    const net   = bucket.reduce((s, t) => s + t.netPnl, 0);
    const wins  = bucket.filter((t) => t.netPnl > 0).length;
    return { label, count: bucket.length, gross, fees, net, winRate: (wins / bucket.length) * 100 };
  });

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500">
            <th className="px-3 py-2 text-left">Period</th>
            <th className="px-3 py-2 text-right">Trades</th>
            <th className="px-3 py-2 text-right">Gross</th>
            <th className="px-3 py-2 text-right">Fees</th>
            <th className="px-3 py-2 text-right font-semibold">Net</th>
            <th className="px-3 py-2 text-right">Win %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, count, gross, fees, net, winRate }) => {
            const isPos = net > 0;
            const isNeg = net < 0;
            return (
              <tr key={label} className="border-b border-zinc-900/60 hover:bg-zinc-800/20">
                <td className="px-3 py-1.5 text-zinc-400">{label}</td>
                <td className="px-3 py-1.5 text-right text-zinc-500">{count || '—'}</td>
                <td className={`px-3 py-1.5 text-right ${count ? (gross >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-zinc-700'}`}>
                  {count ? `${SIGN(gross)}${FMT(gross)}` : '—'}
                </td>
                <td className="px-3 py-1.5 text-right text-zinc-600">
                  {count ? `−${FMT(fees)}` : '—'}
                </td>
                <td className={`px-3 py-1.5 text-right font-semibold ${count ? (isPos ? 'text-emerald-400' : isNeg ? 'text-red-400' : 'text-zinc-400') : 'text-zinc-700'}`}>
                  {count ? `${SIGN(net)}${FMT(net)}` : '—'}
                </td>
                <td className={`px-3 py-1.5 text-right ${count && winRate !== null ? (winRate >= 50 ? 'text-emerald-400' : 'text-red-400') : 'text-zinc-700'}`}>
                  {count && winRate !== null ? `${winRate.toFixed(0)}%` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Trade history + summary ──────────────────────────────────────

function TradeHistory({ trades }: { trades: ClosedTrade[] }) {
  const sorted = useMemo(() => [...trades].sort((a, b) => b.exitTime - a.exitTime), [trades]);

  const wins = useMemo(() => sorted.filter((t) => t.netPnl > 0), [sorted]);
  const losses = useMemo(() => sorted.filter((t) => t.netPnl <= 0), [sorted]);
  const totalNet = useMemo(() => sorted.reduce((s, t) => s + t.netPnl, 0), [sorted]);
  const totalFees = useMemo(() => sorted.reduce((s, t) => s + t.fee, 0), [sorted]);
  const totalGross = useMemo(() => sorted.reduce((s, t) => s + t.grossPnl, 0), [sorted]);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPnl, 0) / wins.length : null;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPnl, 0) / losses.length : null;
  const best = sorted.length > 0 ? sorted.reduce((b, t) => t.netPnl > b.netPnl ? t : b) : null;
  const worst = sorted.length > 0 ? sorted.reduce((w, t) => t.netPnl < w.netPnl ? t : w) : null;
  const winRate = sorted.length > 0 ? (wins.length / sorted.length) * 100 : 0;

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 text-sm text-zinc-500">
        No closed trades yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* P&L by period */}
      <PnLBreakdown trades={trades} />

      {/* Summary stats grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total trades" value={`${sorted.length}`} />
        <StatCard
          label="Win / Loss"
          value={`${wins.length} W  ${losses.length} L`}
          sub={`${winRate.toFixed(0)}% win rate`}
          tone={winRate >= 50 ? 'green' : 'red'}
        />
        <StatCard
          label="Net PnL (all-time)"
          value={`${SIGN(totalNet)}${FMT(totalNet)}`}
          tone={totalNet >= 0 ? 'green' : 'red'}
        />
        <StatCard label="Total fees paid" value={FMT(totalFees)} tone="dim" />
        <StatCard label="Gross PnL" value={`${SIGN(totalGross)}${FMT(totalGross)}`} tone={totalGross >= 0 ? 'green' : 'dim'} />
        <StatCard label="Avg win" value={avgWin !== null ? `${SIGN(avgWin)}${FMT(avgWin)}` : '—'} tone="green" />
        <StatCard label="Avg loss" value={avgLoss !== null ? `${FMT(avgLoss)}` : '—'} tone="red" />
        <StatCard
          label="Best / Worst"
          value={best && worst ? `${SIGN(best.netPnl)}${FMT(best.netPnl)} / ${FMT(worst.netPnl)}` : '—'}
          sub={best && worst ? `${best.pair} / ${worst.pair}` : undefined}
          tone={best && worst ? (best.netPnl > Math.abs(worst.netPnl) ? 'green' : 'red') : 'dim'}
        />
      </div>

      {/* Loss breakdown warning */}
      {totalNet < -10 && (
        <div className="rounded-xl border border-red-800/50 bg-red-950/20 px-4 py-3 text-sm text-red-300">
          <span className="font-semibold">Account drawdown detected.</span>{' '}
          Net losses: {FMT(Math.abs(totalNet))} across {losses.length} losing trades.
          {losses.length > 0 && ` Largest single loss: ${FMT(worst!.netPnl)} on ${worst!.pair} (${worst!.exchange}).`}
          {' '}Fees consumed {FMT(totalFees)} ({totalGross !== 0 ? ((totalFees / Math.abs(totalGross)) * 100).toFixed(0) : '?'}% of gross).
        </div>
      )}

      {/* Trades table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-zinc-900">
              <tr className="border-b border-zinc-800 text-zinc-500">
                <th className="px-2 py-2 text-left">Time</th>
                <th className="px-2 py-2 text-left">Exchange</th>
                <th className="px-2 py-2 text-left">Pair</th>
                <th className="px-2 py-2 text-right">Volume</th>
                <th className="px-2 py-2 text-right">Entry</th>
                <th className="px-2 py-2 text-right">Exit</th>
                <th className="px-2 py-2 text-right">Gross</th>
                <th className="px-2 py-2 text-right">Fee</th>
                <th className="px-2 py-2 text-right font-semibold">Net</th>
                <th className="px-2 py-2 text-center">Chart</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, i) => {
                const win = t.netPnl > 0;
                return (
                  <tr
                    key={i}
                    className={`border-b border-zinc-900/60 ${win ? 'bg-emerald-950/10' : 'bg-red-950/10'}`}
                  >
                    <td className="px-2 py-1.5 text-zinc-500">{fmtDate(t.exitTime)}</td>
                    <td className="px-2 py-1.5 capitalize text-zinc-400">{t.exchange}</td>
                    <td className="px-2 py-1.5 text-zinc-200">{t.pair}</td>
                    <td className="px-2 py-1.5 text-right text-zinc-400">{t.volume.toFixed(6)}</td>
                    <td className="px-2 py-1.5 text-right text-zinc-400">${fmtPrice(t.entryPrice)}</td>
                    <td className="px-2 py-1.5 text-right text-zinc-400">${fmtPrice(t.exitPrice)}</td>
                    <td className={`px-2 py-1.5 text-right ${t.grossPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {SIGN(t.grossPnl)}{FMT(t.grossPnl)}
                    </td>
                    <td className="px-2 py-1.5 text-right text-zinc-600">−{FMT(t.fee)}</td>
                    <td className={`px-2 py-1.5 text-right font-semibold ${win ? 'text-emerald-400' : 'text-red-400'}`}>
                      {SIGN(t.netPnl)}{FMT(t.netPnl)}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <Sparkline samples={t.priceSamples} profitable={t.netPnl >= 0} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label, value, sub, tone,
}: {
  label: string; value: string; sub?: string; tone?: 'green' | 'red' | 'dim';
}) {
  const valueColor = tone === 'green' ? 'text-emerald-400'
    : tone === 'red' ? 'text-red-400'
    : 'text-zinc-100';
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-base font-semibold ${valueColor}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────

export function GrowthProjection() {
  const { trade, loading } = useSourceState();

  const closedTrades = useMemo(() => trade?.tradeState?.closedTrades ?? [], [trade]);
  const dailyPnl = trade?.tradeStatus?.dailyPnl ?? 0;

  const derivedHourly = useMemo(() => {
    if (closedTrades.length >= 2) {
      const total = closedTrades.reduce((s, t) => s + t.netPnl, 0);
      let oldest = Infinity, newest = -Infinity;
      for (const t of closedTrades) {
        if (t.exitTime < oldest) oldest = t.exitTime;
        if (t.exitTime > newest) newest = t.exitTime;
      }
      const hours = (newest - oldest) / 3_600_000;
      if (hours > 0) return Math.max(0, total / hours);
    }
    if (dailyPnl !== 0) return Math.abs(dailyPnl) / 24;
    return 0.5;
  }, [closedTrades, dailyPnl]);

  const firstTradeMs = useMemo(() => {
    if (closedTrades.length === 0) return Date.now() - 7 * 86_400_000;
    return Math.min(...closedTrades.map((t) => t.exitTime));
  }, [closedTrades]);

  const [bankroll, setBankroll] = useState(300);
  const [hourlyProfit, setHourlyProfit] = useState(0.5);
  const [projectionDays, setProjectionDays] = useState(365);
  const [seeded, setSeeded] = useState(false);
  const [activeTab, setActiveTab] = useState<'projection' | 'history'>('projection');

  useEffect(() => {
    if (seeded || loading) return;
    if (derivedHourly > 0) setHourlyProfit(parseFloat(derivedHourly.toFixed(4)));
    setSeeded(true);
  }, [seeded, loading, derivedHourly]);

  const { flat, compounded, conservative, riskAdjusted, dailyRate } = useMemo(
    () => buildProjection(bankroll, hourlyProfit, firstTradeMs, projectionDays),
    [bankroll, hourlyProfit, firstTradeMs, projectionDays],
  );
  const real = useMemo(
    () => buildReal(bankroll, closedTrades, firstTradeMs),
    [bankroll, closedTrades, firstTradeMs],
  );

  const chartEl = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const refs = useRef<{
    flat: ISeriesApi<'Line'> | null;
    compounded: ISeriesApi<'Line'> | null;
    conservative: ISeriesApi<'Line'> | null;
    riskAdjusted: ISeriesApi<'Line'> | null;
    real: ISeriesApi<'Line'> | null;
  }>({ flat: null, compounded: null, conservative: null, riskAdjusted: null, real: null });

  useEffect(() => {
    if (!chartEl.current) return;
    const chart = createChart(chartEl.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a1a1aa',
      },
      grid: {
        vertLines: { color: 'rgba(63, 63, 70, 0.35)' },
        horzLines: { color: 'rgba(63, 63, 70, 0.35)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(82, 82, 91, 0.7)' },
      timeScale: {
        borderColor: 'rgba(82, 82, 91, 0.7)',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    refs.current.flat = chart.addSeries(LineSeries, { color: '#52525b', lineWidth: 1, lineStyle: 2, title: 'Flat' });
    refs.current.compounded = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2, title: 'Compound' });
    refs.current.conservative = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, lineStyle: 1, title: 'Conservative' });
    refs.current.riskAdjusted = chart.addSeries(LineSeries, { color: '#f97316', lineWidth: 1, title: 'Risk-adj' });
    refs.current.real = chart.addSeries(LineSeries, { color: '#22c55e', lineWidth: 2, title: 'Actual' });
    chartRef.current = chart;

    const ro = new ResizeObserver(() => chart.timeScale().fitContent());
    ro.observe(chartEl.current!);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      refs.current = { flat: null, compounded: null, conservative: null, riskAdjusted: null, real: null };
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    refs.current.flat?.setData(flat);
    refs.current.compounded?.setData(compounded);
    refs.current.conservative?.setData(conservative);
    refs.current.riskAdjusted?.setData(riskAdjusted);
    refs.current.real?.setData(real);
    chartRef.current.timeScale().fitContent();
  }, [flat, compounded, conservative, riskAdjusted, real]);

  const projRows = useMemo(() => {
    const now = Date.now();
    // Observed daily rate from actual trade history
    const totalNetPnl = closedTrades.reduce((s, t) => s + t.netPnl, 0);
    const daysElapsed = closedTrades.length >= 2
      ? (Math.max(...closedTrades.map((t) => t.exitTime)) - firstTradeMs) / 86_400_000
      : 0;
    const currentBalance = bankroll + totalNetPnl;
    const observedDailyRate = daysElapsed > 0 && currentBalance > 0 && bankroll > 0
      ? Math.pow(currentBalance / bankroll, 1 / daysElapsed) - 1
      : null;

    return BREAKPOINTS.map(({ days, label }) => {
      const conservativeRate = Math.min(dailyRate, Math.pow(1 + MAX_MONTHLY_GROWTH, 1 / 30) - 1);
      const riskRate = dailyRate * RISK_HAIRCUT;
      const targetMs = firstTradeMs + days * 86_400_000;

      let realtime: number | null = null;
      if (closedTrades.length > 0) {
        if (targetMs <= now) {
          // Past: sum trades that closed on or before this breakpoint
          const cum = closedTrades
            .filter((t) => t.exitTime <= targetMs)
            .reduce((s, t) => s + t.netPnl, 0);
          realtime = bankroll + cum;
        } else if (observedDailyRate !== null) {
          // Future: project forward from current balance using observed rate
          const daysRemaining = (targetMs - now) / 86_400_000;
          realtime = currentBalance * Math.pow(1 + observedDailyRate, daysRemaining);
        }
      }

      return {
        label,
        days,
        isPast: targetMs <= now,
        flat: bankroll + hourlyProfit * days * 24,
        compound: bankroll * Math.pow(1 + dailyRate, days),
        conservative: bankroll * Math.pow(1 + conservativeRate, days),
        riskAdj: bankroll * Math.pow(1 + riskRate, days),
        realtime,
      };
    });
  }, [bankroll, hourlyProfit, dailyRate, closedTrades, firstTradeMs]);

  const dailyRatePct = (dailyRate * 100).toFixed(3);
  const hourlyRatePct = ((Math.pow(1 + dailyRate, 1 / 24) - 1) * 100).toFixed(4);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-zinc-100">Growth &amp; Trade History</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Projection curves vs actual bot PnL, plus a full trade-by-trade breakdown.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right text-xs text-zinc-500">
          <span>Daily rate: {dailyRatePct}%</span>
          <span>Hourly rate: {hourlyRatePct}%</span>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="mb-5 flex gap-2">
        {(['projection', 'history'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${
              activeTab === t
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t === 'projection' ? 'Projection' : `Trade History (${closedTrades.length})`}
          </button>
        ))}
      </div>

      {activeTab === 'projection' ? (
        <>
          {/* Controls */}
          <div className="mb-4 flex flex-wrap gap-4">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Bankroll ($)
              <input
                type="number"
                min={0}
                value={bankroll}
                onChange={(e) => setBankroll(Math.max(0, Number(e.target.value)))}
                className="w-28 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Hourly profit ($)
              <input
                type="number"
                min={0}
                step={0.01}
                value={hourlyProfit}
                onChange={(e) => setHourlyProfit(Math.max(0, Number(e.target.value)))}
                className="w-28 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Projection period
              <select
                value={projectionDays}
                onChange={(e) => setProjectionDays(Number(e.target.value))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              >
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
                <option value={365}>365 days</option>
              </select>
            </label>
          </div>

          <div className="mb-3 flex flex-wrap gap-4 text-xs">
            {([
              { color: 'bg-green-500', label: 'Actual' },
              { color: 'bg-amber-500', label: 'Compounded' },
              { color: 'bg-orange-500', label: 'Risk-adj' },
              { color: 'bg-blue-500', label: 'Conservative' },
              { color: 'bg-zinc-600', label: 'Flat' },
            ] as const).map(({ color, label }) => (
              <div key={label} className="flex items-center gap-1.5">
                <span className={`h-2 w-5 rounded-sm ${color}`} />
                <span className="text-zinc-400">{label}</span>
              </div>
            ))}
          </div>

          <div ref={chartEl} className="h-[300px] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/80" />

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500">
                  <th className="py-2 text-left">Period</th>
                  <th className="py-2 text-right text-emerald-400">Realtime</th>
                  <th className="py-2 text-right">Flat</th>
                  <th className="py-2 text-right text-amber-400">Compounded</th>
                  <th className="py-2 text-right text-orange-400">Risk-adj</th>
                  <th className="py-2 text-right text-blue-400">Conservative</th>
                </tr>
              </thead>
              <tbody>
                {projRows.map(({ label, flat: f, compound, conservative: cons, riskAdj, realtime, isPast }) => (
                  <tr key={label} className="border-b border-zinc-900">
                    <td className="py-1.5 text-zinc-300">{label}</td>
                    <td className="py-1.5 text-right font-semibold">
                      {realtime !== null ? (
                        <span className={realtime >= bankroll ? 'text-emerald-400' : 'text-red-400'}>
                          {FMT(realtime)}
                          {!isPast && <span className="ml-1 text-[10px] text-zinc-600">proj</span>}
                        </span>
                      ) : (
                        <span className="text-zinc-700">—</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right text-zinc-500">{FMT(f)}</td>
                    <td className="py-1.5 text-right text-amber-400">{FMT(compound)}</td>
                    <td className="py-1.5 text-right text-orange-400">{FMT(riskAdj)}</td>
                    <td className="py-1.5 text-right text-blue-400">{FMT(cons)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 space-y-1 text-xs text-zinc-600">
            <p>Projections assume constant profitability with no drawdowns or regime changes.</p>
            <p>Compounding at scale may reduce the effective hourly rate as position sizes grow.</p>
            <p>Illustrative only — not investment advice.</p>
          </div>
        </>
      ) : (
        <TradeHistory trades={closedTrades} />
      )}
    </section>
  );
}
