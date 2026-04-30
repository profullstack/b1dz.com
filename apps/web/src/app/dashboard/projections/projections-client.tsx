'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ColorType, CrosshairMode, LineSeries, createChart,
  type IChartApi, type ISeriesApi, type LineData, type UTCTimestamp,
} from 'lightweight-charts';
import { calculateProjection, fmtUsd, fmtPct, fmtMultiple, exportToCsv, exportToMarkdown } from '@b1dz/projection-engine';
import { useSourceState } from '@/lib/use-source-state';

// ─── Types ────────────────────────────────────────────────────────

type ScaleMode = 'linear' | 'log';

// ─── Helpers ─────────────────────────────────────────────────────

function fmtUsdFull(v: number) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Sub-components ───────────────────────────────────────────────

function SummaryCard({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'green' | 'amber' | 'red' | 'dim';
}) {
  const vc = tone === 'green' ? 'text-emerald-400' : tone === 'amber' ? 'text-amber-400' : tone === 'red' ? 'text-red-400' : 'text-zinc-100';
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${vc}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function NumberInput({ label, value, onChange, step, min, max, hint }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number; max?: number; hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-zinc-400">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 'any'}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
      />
      {hint && <span className="text-xs text-zinc-600">{hint}</span>}
    </label>
  );
}

// ─── Main component ───────────────────────────────────────────────

export function ProjectionsClient() {
  const { trade, loading } = useSourceState();

  const closedTrades = useMemo(() => trade?.tradeState?.closedTrades ?? [], [trade]);
  const dailyPnl = trade?.tradeStatus?.dailyPnl ?? 0;

  // Derive defaults from live data
  const derivedHourly = useMemo(() => {
    if (closedTrades.length >= 2) {
      const total = closedTrades.reduce((s, t) => s + t.netPnl, 0);
      let oldest = Infinity, newest = -Infinity;
      for (const t of closedTrades) {
        if (t.exitTime < oldest) oldest = t.exitTime;
        if (t.exitTime > newest) newest = t.exitTime;
      }
      const hours = (newest - oldest) / 3_600_000;
      if (hours > 0 && total > 0) return total / hours;
    }
    if (dailyPnl > 0) return dailyPnl / 24;
    return 0.5;
  }, [closedTrades, dailyPnl]);

  // Inputs — all from PRD section 4.1
  const [startingBankroll, setStartingBankroll] = useState(300);
  const [hourlyProfit, setHourlyProfit] = useState(0.5);
  const [days, setDays] = useState(365);
  const [reinvestmentRate, setReinvestmentRate] = useState(1);
  const [scalingFactor, setScalingFactor] = useState(1);
  const [feeRate, setFeeRate] = useState(0);
  const [slippageRate, setSlippageRate] = useState(0);
  const [failureRate, setFailureRate] = useState(0);
  const [drawdownHaircut, setDrawdownHaircut] = useState(0);
  const [maxHourlyProfitEnabled, setMaxHourlyProfitEnabled] = useState(false);
  const [maxHourlyProfitVal, setMaxHourlyProfitVal] = useState(10);
  const [liquidityCapEnabled, setLiquidityCapEnabled] = useState(false);
  const [liquidityCapVal, setLiquidityCapVal] = useState(10_000);
  const [scaleMode, setScaleMode] = useState<ScaleMode>('log');
  const [seeded, setSeeded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (seeded || loading) return;
    if (derivedHourly > 0) setHourlyProfit(parseFloat(derivedHourly.toFixed(4)));
    setSeeded(true);
  }, [seeded, loading, derivedHourly]);

  const result = useMemo(() => calculateProjection({
    startingBankroll,
    hourlyProfit,
    days,
    reinvestmentRate,
    scalingFactor,
    feeRate,
    slippageRate,
    failureRate,
    drawdownHaircut,
    maxHourlyProfit: maxHourlyProfitEnabled ? maxHourlyProfitVal : Infinity,
    liquidityCap: liquidityCapEnabled ? liquidityCapVal : Infinity,
  }), [startingBankroll, hourlyProfit, days, reinvestmentRate, scalingFactor,
      feeRate, slippageRate, failureRate, drawdownHaircut,
      maxHourlyProfitEnabled, maxHourlyProfitVal, liquidityCapEnabled, liquidityCapVal]);

  // ─── Chart ──────────────────────────────────────────────────────
  const chartEl = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    linear: ISeriesApi<'Line'> | null;
    naive: ISeriesApi<'Line'> | null;
    conservative: ISeriesApi<'Line'> | null;
    riskAdjusted: ISeriesApi<'Line'> | null;
  }>({ linear: null, naive: null, conservative: null, riskAdjusted: null });

  useEffect(() => {
    if (!chartEl.current) return;
    const chart = createChart(chartEl.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a1a1aa',
      },
      grid: {
        vertLines: { color: 'rgba(63,63,70,0.35)' },
        horzLines: { color: 'rgba(63,63,70,0.35)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(82,82,91,0.7)', mode: scaleMode === 'log' ? 1 : 0 },
      timeScale: { borderColor: 'rgba(82,82,91,0.7)', timeVisible: false, secondsVisible: false },
    });
    seriesRef.current.linear = chart.addSeries(LineSeries, { color: '#71717a', lineWidth: 1, lineStyle: 2, title: 'Linear' });
    seriesRef.current.naive = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2, title: 'Naive Compound' });
    seriesRef.current.conservative = chart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, title: 'Conservative' });
    seriesRef.current.riskAdjusted = chart.addSeries(LineSeries, { color: '#22c55e', lineWidth: 2, title: 'Risk-Adjusted' });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.timeScale().fitContent());
    ro.observe(chartEl.current!);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = { linear: null, naive: null, conservative: null, riskAdjusted: null };
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update price scale mode without recreating chart
  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({ mode: scaleMode === 'log' ? 1 : 0 });
  }, [scaleMode]);

  // Build chart data: use day as a fake UTCTimestamp (day * 86400 so it renders as a date)
  const baseTs = useMemo(() => Math.floor(Date.now() / 1000) - days * 86400, [days]);
  const toLine = (pts: { day: number; bankroll: number }[]): LineData<UTCTimestamp>[] =>
    pts.map((p) => ({ time: (baseTs + p.day * 86400) as UTCTimestamp, value: p.bankroll }));

  useEffect(() => {
    if (!chartRef.current) return;
    seriesRef.current.linear?.setData(toLine(result.series.linear));
    seriesRef.current.naive?.setData(toLine(result.series.naiveCompounded));
    seriesRef.current.conservative?.setData(toLine(result.series.conservative));
    seriesRef.current.riskAdjusted?.setData(toLine(result.series.riskAdjusted));
    chartRef.current.timeScale().fitContent();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, baseTs]);

  const { derived, checkpoints, warnings } = result;

  const criticalWarning = warnings.find((w) => w.severity === 'critical');
  const warnWarning = warnings.find((w) => w.severity === 'warn');

  function handleExportCsv() {
    downloadFile('b1dz-projection.csv', exportToCsv(checkpoints), 'text/csv');
  }

  function handleExportMd() {
    downloadFile('b1dz-projection.md', exportToMarkdown(result), 'text/markdown');
  }

  function handleExportJson() {
    downloadFile('b1dz-projection.json', JSON.stringify(result, null, 2), 'application/json');
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Starting bankroll" value={fmtUsdFull(startingBankroll)} />
        <SummaryCard label="Hourly profit" value={fmtUsdFull(hourlyProfit)} sub="per hour" />
        <SummaryCard label="Hourly return" value={fmtPct(derived.hourlyReturnRate, 4)} tone="amber" />
        <SummaryCard label="Daily compound return" value={fmtPct(derived.dailyCompoundedReturn, 3)} tone="amber" />
        <SummaryCard label="Flat daily profit" value={fmtUsd(derived.dailyFlatProfit)} tone="green" />
        <SummaryCard label="Flat weekly profit" value={fmtUsd(derived.weeklyFlatProfit)} tone="green" />
        <SummaryCard label="Flat monthly profit" value={fmtUsd(derived.monthlyFlatProfit)} tone="green" />
        <SummaryCard
          label="Naive 1-year compound"
          value={fmtUsd(result.series.naiveCompounded.at(-1)?.bankroll ?? 0)}
          sub={`${fmtMultiple(startingBankroll, result.series.naiveCompounded.at(-1)?.bankroll ?? 0)} (naive)`}
          tone="amber"
        />
      </div>

      {/* Warnings */}
      {criticalWarning && (
        <div className="rounded-xl border border-red-700/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          <strong>Critical:</strong> {criticalWarning.message}
        </div>
      )}
      {warnWarning && !criticalWarning && (
        <div className="rounded-xl border border-amber-700/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-300">
          {warnWarning.message}
        </div>
      )}

      {/* Inputs */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Inputs</h2>
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            {showAdvanced ? 'Hide advanced' : 'Show advanced'}
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberInput label="Starting bankroll ($)" value={startingBankroll} onChange={setStartingBankroll} min={0} step={1} />
          <NumberInput label="Hourly profit ($)" value={hourlyProfit} onChange={setHourlyProfit} min={0} step={0.01} hint="Auto-seeded from bot history" />
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Projection period</span>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
            >
              {[7, 14, 30, 60, 90, 180, 365].map((d) => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Conservative scaling</span>
            <select
              value={scalingFactor}
              onChange={(e) => setScalingFactor(Number(e.target.value))}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
            >
              <option value={0.1}>Very conservative (0.10×)</option>
              <option value={0.25}>Conservative (0.25×)</option>
              <option value={0.5}>Moderate (0.50×)</option>
              <option value={0.75}>Aggressive (0.75×)</option>
              <option value={1}>Naive / perfect (1.00×)</option>
            </select>
          </div>
        </div>

        {showAdvanced && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NumberInput label="Reinvestment rate (0–1)" value={reinvestmentRate} onChange={setReinvestmentRate} min={0} max={1} step={0.01} hint="1 = fully reinvest profits" />
            <NumberInput label="Fee rate (0–1)" value={feeRate} onChange={setFeeRate} min={0} max={1} step={0.001} hint="e.g. 0.003 = 0.3%" />
            <NumberInput label="Slippage rate (0–1)" value={slippageRate} onChange={setSlippageRate} min={0} max={1} step={0.001} hint="e.g. 0.002 = 0.2%" />
            <NumberInput label="Failure rate (0–1)" value={failureRate} onChange={setFailureRate} min={0} max={1} step={0.01} hint="Fraction of trades that fail" />
            <NumberInput label="Drawdown haircut (0–1)" value={drawdownHaircut} onChange={setDrawdownHaircut} min={0} max={1} step={0.01} hint="Expected periodic drawdown" />
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={maxHourlyProfitEnabled} onChange={(e) => setMaxHourlyProfitEnabled(e.target.checked)} />
                Max hourly profit cap ($)
              </label>
              <input
                type="number" min={0} step={0.1} value={maxHourlyProfitVal}
                disabled={!maxHourlyProfitEnabled}
                onChange={(e) => setMaxHourlyProfitVal(Number(e.target.value))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500 disabled:opacity-40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={liquidityCapEnabled} onChange={(e) => setLiquidityCapEnabled(e.target.checked)} />
                Liquidity cap ($)
              </label>
              <input
                type="number" min={0} step={100} value={liquidityCapVal}
                disabled={!liquidityCapEnabled}
                onChange={(e) => setLiquidityCapVal(Number(e.target.value))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500 disabled:opacity-40"
              />
            </div>
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Projection Chart</h2>
            <p className="mt-0.5 text-xs text-zinc-500">X-axis: days from today. Y-axis: bankroll USD.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex overflow-hidden rounded-lg border border-zinc-700">
              {(['linear', 'log'] as ScaleMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setScaleMode(m)}
                  className={`px-3 py-1 text-xs transition ${scaleMode === m ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  {m === 'log' ? 'Log scale' : 'Linear scale'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap gap-4 text-xs">
          {([
            { color: 'bg-zinc-500', label: 'Linear' },
            { color: 'bg-amber-500', label: 'Naive Compound' },
            { color: 'bg-blue-500', label: 'Conservative' },
            { color: 'bg-green-500', label: 'Risk-Adjusted' },
          ] as const).map(({ color, label }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className={`h-2 w-5 rounded-sm ${color}`} />
              <span className="text-zinc-400">{label}</span>
            </div>
          ))}
        </div>

        <div ref={chartEl} className="h-[360px] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/80" />

        {scaleMode === 'linear' && criticalWarning && (
          <p className="mt-2 text-xs text-amber-500">
            Naive compound dwarfs other curves on linear scale — try log scale for a readable comparison.
          </p>
        )}
      </div>

      {/* Checkpoint table */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <h2 className="mb-3 text-lg font-semibold">Projection Checkpoints</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500">
                <th className="py-2 text-left">Day</th>
                <th className="py-2 text-right text-zinc-400">Linear</th>
                <th className="py-2 text-right text-amber-400">Naive Compound</th>
                <th className="py-2 text-right text-blue-400">Conservative</th>
                <th className="py-2 text-right text-green-400">Risk-Adjusted</th>
                <th className="py-2 text-right text-zinc-500">Hourly profit at size</th>
              </tr>
            </thead>
            <tbody>
              {checkpoints.map((c) => (
                <tr key={c.day} className="border-b border-zinc-900">
                  <td className="py-1.5 font-medium text-zinc-300">Day {c.day}</td>
                  <td className="py-1.5 text-right text-zinc-400">{fmtUsd(c.linearBankroll)}</td>
                  <td className="py-1.5 text-right text-amber-400">{fmtUsd(c.naiveCompoundedBankroll)}</td>
                  <td className="py-1.5 text-right text-blue-400">{fmtUsd(c.conservativeBankroll)}</td>
                  <td className="py-1.5 text-right text-green-400">{fmtUsd(c.riskAdjustedBankroll)}</td>
                  <td className="py-1.5 text-right text-zinc-500">{fmtUsd(c.hourlyProfitAtSize, 4)}/hr</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* All warnings */}
      {warnings.length > 0 && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
          <h2 className="mb-3 text-lg font-semibold">Risk Notes</h2>
          <div className="space-y-2">
            {warnings.map((w, i) => (
              <div
                key={i}
                className={`rounded-lg px-4 py-3 text-sm ${
                  w.severity === 'critical'
                    ? 'border border-red-700/50 bg-red-950/30 text-red-300'
                    : w.severity === 'warn'
                    ? 'border border-amber-700/50 bg-amber-950/20 text-amber-300'
                    : 'border border-zinc-700 bg-zinc-950/50 text-zinc-400'
                }`}
              >
                {w.message}
              </div>
            ))}
            <p className="text-xs text-zinc-600">
              This is a projection tool, not financial advice or a guarantee of future returns.
            </p>
          </div>
        </div>
      )}

      {/* Export */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <h2 className="mb-3 text-lg font-semibold">Export</h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleExportCsv}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition"
          >
            Download CSV
          </button>
          <button
            onClick={handleExportMd}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition"
          >
            Download Markdown
          </button>
          <button
            onClick={handleExportJson}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition"
          >
            Download JSON
          </button>
        </div>
      </div>
    </div>
  );
}
