'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ColorType, CrosshairMode, LineSeries, createChart,
  type IChartApi, type ISeriesApi, type LineData, type UTCTimestamp,
} from 'lightweight-charts';
import {
  calculateEdgeRetentionProjection,
  calculateProjection,
  fmtUsd, fmtPct, fmtMultiple, exportToCsv, exportToMarkdown,
  type EdgeScenario,
} from '@b1dz/projection-engine';
import { useSourceState } from '@/lib/use-source-state';

// ─── Types ────────────────────────────────────────────────────────

type ScaleMode = 'linear' | 'log';

// ─── Helpers ─────────────────────────────────────────────────────

function fmtUsdFull(v: number) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function fmtX(v: number) {
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M×`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K×`;
  return `${v.toFixed(2)}×`;
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
  label: string; value: string; sub?: string;
  tone?: 'green' | 'amber' | 'red' | 'violet' | 'cyan' | 'dim';
}) {
  const vc =
    tone === 'green' ? 'text-emerald-400' :
    tone === 'amber' ? 'text-amber-400' :
    tone === 'red' ? 'text-red-400' :
    tone === 'violet' ? 'text-violet-400' :
    tone === 'cyan' ? 'text-cyan-400' :
    'text-zinc-100';
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
        type="number" value={value} min={min} max={max} step={step ?? 'any'}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
      />
      {hint && <span className="text-xs text-zinc-600">{hint}</span>}
    </label>
  );
}

// Scenario colors — ordered by retention level (high → low)
const SCENARIO_COLORS = [
  '#f59e0b', // amber  — 100%
  '#fb923c', // orange — 50%
  '#a78bfa', // violet — 25%
  '#60a5fa', // blue   — 20%
  '#22c55e', // green  — break-even
  '#06b6d4', // cyan   — 10%
  '#94a3b8', // slate  — 5%
  '#6b7280', // gray   — 1%
];

// ─── Main component ───────────────────────────────────────────────

export function ProjectionsClient() {
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
      if (hours > 0 && total > 0) return total / hours;
    }
    if (dailyPnl > 0) return dailyPnl / 24;
    return 0.5;
  }, [closedTrades, dailyPnl]);

  // ── Shared inputs ─────────────────────────────────────────────
  const [startingBankroll, setStartingBankroll] = useState(300);
  const [days, setDays] = useState(365);

  // ── Edge retention inputs ─────────────────────────────────────
  const [observedHourlyProfit, setObservedHourlyProfit] = useState(0.5);
  const [targetHourlyProfit, setTargetHourlyProfit] = useState(0.5);
  const [feeHaircut, setFeeHaircut] = useState(0.001);
  const [slippageHaircut, setSlippageHaircut] = useState(0.001);
  const [failureHaircut, setFailureHaircut] = useState(0.02);
  const [drawdownHaircut, setDrawdownHaircut] = useState(0.05);

  // ── Classic perf projection inputs ───────────────────────────
  const [scalingFactor, setScalingFactor] = useState(0.5);
  const [reinvestmentRate, setReinvestmentRate] = useState(1);
  const [maxHourlyProfitEnabled, setMaxHourlyProfitEnabled] = useState(false);
  const [maxHourlyProfitVal, setMaxHourlyProfitVal] = useState(10);
  const [liquidityCapEnabled, setLiquidityCapEnabled] = useState(false);
  const [liquidityCapVal, setLiquidityCapVal] = useState(10_000);

  const [scaleMode, setScaleMode] = useState<ScaleMode>('linear');
  const [seeded, setSeeded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (loading || seeded) return;
    if (derivedHourly > 0) {
      const h = parseFloat(derivedHourly.toFixed(4));
      setObservedHourlyProfit(h);
      setTargetHourlyProfit(h);
    }
    setSeeded(true);
  }, [seeded, loading, derivedHourly]);

  // ── Calculations ──────────────────────────────────────────────
  const erResult = useMemo(() => calculateEdgeRetentionProjection({
    startingBankroll,
    observedHourlyProfit,
    targetHourlyProfit,
    days,
    feeHaircut,
    slippageHaircut,
    failureHaircut,
    drawdownHaircut,
  }), [startingBankroll, observedHourlyProfit, targetHourlyProfit, days,
      feeHaircut, slippageHaircut, failureHaircut, drawdownHaircut]);

  const perfResult = useMemo(() => calculateProjection({
    startingBankroll,
    hourlyProfit: observedHourlyProfit,
    days,
    reinvestmentRate,
    scalingFactor,
    feeRate: feeHaircut,
    slippageRate: slippageHaircut,
    failureRate: failureHaircut,
    drawdownHaircut,
    maxHourlyProfit: maxHourlyProfitEnabled ? maxHourlyProfitVal : Infinity,
    liquidityCap: liquidityCapEnabled ? liquidityCapVal : Infinity,
  }), [startingBankroll, observedHourlyProfit, days, reinvestmentRate, scalingFactor,
      feeHaircut, slippageHaircut, failureHaircut, drawdownHaircut,
      maxHourlyProfitEnabled, maxHourlyProfitVal, liquidityCapEnabled, liquidityCapVal]);

  // ── Chart setup ───────────────────────────────────────────────
  const chartEl = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const scenarioSeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const linearSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const actualGainRef = useRef<ISeriesApi<'Line'> | null>(null);
  const actualLossRef = useRef<ISeriesApi<'Line'> | null>(null);

  // visible: scenario labels → boolean, plus 'linear' and 'actual'
  const [visibleSeries, setVisibleSeries] = useState<Record<string, boolean>>({});

  const toggleSeries = (key: string) => {
    setVisibleSeries((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (key === 'actual') {
        actualGainRef.current?.applyOptions({ visible: next.actual });
        actualLossRef.current?.applyOptions({ visible: next.actual });
      } else if (key === 'linear') {
        linearSeriesRef.current?.applyOptions({ visible: next.linear });
      } else {
        scenarioSeriesRef.current.get(key)?.applyOptions({ visible: next[key] });
      }
      return next;
    });
  };

  // Rebuild chart when number of scenarios changes (new series needed)
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

    // Scenario series (sorted high→low retention)
    const sorted = [...erResult.scenarios].sort((a, b) => b.edgeRetention - a.edgeRetention);
    const newMap = new Map<string, ISeriesApi<'Line'>>();
    sorted.forEach((s, i) => {
      const color = SCENARIO_COLORS[i % SCENARIO_COLORS.length]!;
      const isBreakEven = Math.abs(s.edgeRetention - erResult.derived.requiredEdgeRetention) < 0.005;
      newMap.set(s.label, chart.addSeries(LineSeries, {
        color,
        lineWidth: isBreakEven ? 3 : 1,
        lineStyle: isBreakEven ? 0 : 2,
        title: s.label,
      }));
    });
    scenarioSeriesRef.current = newMap;

    linearSeriesRef.current = chart.addSeries(LineSeries, { color: '#71717a', lineWidth: 1, lineStyle: 3, title: 'Linear' });
    actualGainRef.current = chart.addSeries(LineSeries, { color: '#22c55e', lineWidth: 2, title: 'Actual (gain)' });
    actualLossRef.current = chart.addSeries(LineSeries, { color: '#ef4444', lineWidth: 2, title: 'Actual (loss)' });
    chartRef.current = chart;

    // Default visibility — hide 100% and show the rest
    const initVisible: Record<string, boolean> = { linear: true, actual: true };
    sorted.forEach((s) => { initVisible[s.label] = Math.abs(s.edgeRetention - 1) < 0.001 ? false : true; });
    setVisibleSeries(initVisible);

    const ro = new ResizeObserver(() => chart.timeScale().fitContent());
    ro.observe(chartEl.current!);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      scenarioSeriesRef.current = new Map();
      linearSeriesRef.current = null;
      actualGainRef.current = null;
      actualLossRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erResult.scenarios.length]);

  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({ mode: scaleMode === 'log' ? 1 : 0 });
  }, [scaleMode]);

  const baseTs = useMemo(() => Math.floor(Date.now() / 1000) - days * 86400, [days]);

  const actualSeries = useMemo(() => {
    const sorted = [...closedTrades].sort((a, b) => a.exitTime - b.exitTime);
    const gainPts: LineData<UTCTimestamp>[] = [];
    const lossPts: LineData<UTCTimestamp>[] = [];
    let cum = 0;
    for (const t of sorted) {
      cum += t.netPnl;
      const value = startingBankroll + cum;
      const time = Math.floor(t.exitTime / 1000) as UTCTimestamp;
      if (value >= startingBankroll) gainPts.push({ time, value });
      else lossPts.push({ time, value });
    }
    return { gainPts, lossPts };
  }, [closedTrades, startingBankroll]);

  // Update series data
  useEffect(() => {
    if (!chartRef.current) return;
    for (const [label, api] of scenarioSeriesRef.current) {
      const scenario = erResult.scenarios.find((s) => s.label === label);
      if (!scenario) continue;
      const data: LineData<UTCTimestamp>[] = scenario.series.map((p) => ({
        time: (baseTs + p.day * 86400) as UTCTimestamp,
        value: p.bankroll,
      }));
      api.setData(data);
    }
    linearSeriesRef.current?.setData(
      erResult.linearSeries.map((p) => ({
        time: (baseTs + p.day * 86400) as UTCTimestamp,
        value: p.bankroll,
      })),
    );
    actualGainRef.current?.setData(actualSeries.gainPts);
    actualLossRef.current?.setData(actualSeries.lossPts);
    chartRef.current.timeScale().fitContent();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erResult, baseTs, actualSeries]);

  // Apply visibility state when it changes
  useEffect(() => {
    for (const [label, api] of scenarioSeriesRef.current) {
      const vis = visibleSeries[label];
      if (vis !== undefined) api.applyOptions({ visible: vis });
    }
    if (visibleSeries.linear !== undefined) linearSeriesRef.current?.applyOptions({ visible: visibleSeries.linear });
    if (visibleSeries.actual !== undefined) {
      actualGainRef.current?.applyOptions({ visible: visibleSeries.actual });
      actualLossRef.current?.applyOptions({ visible: visibleSeries.actual });
    }
  }, [visibleSeries]);

  const { derived: ed, scenarios, checkpoints: ec, warnings: ew } = erResult;
  const { checkpoints: pc, warnings: pw } = perfResult;
  const allWarnings = [...ew, ...pw];

  const scenariosSorted = [...scenarios].sort((a, b) => b.edgeRetention - a.edgeRetention);

  function handleExportCsv() {
    downloadFile('b1dz-projection.csv', exportToCsv(pc), 'text/csv');
  }
  function handleExportMd() {
    downloadFile('b1dz-projection.md', exportToMarkdown(perfResult), 'text/markdown');
  }
  function handleExportJson() {
    downloadFile('b1dz-projection.json', JSON.stringify({ edgeRetention: erResult, performance: perfResult }, null, 2), 'application/json');
  }

  return (
    <div className="space-y-6">

      {/* ── Shared inputs ─────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-4 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-400">Starting bankroll ($)</span>
          <input type="number" min={0} step={1} value={startingBankroll}
            onChange={(e) => setStartingBankroll(Number(e.target.value))}
            className="w-36 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-400">Projection period</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          >
            {[7, 14, 30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </div>
        <NumberInput label="Observed hourly profit ($)" value={observedHourlyProfit} onChange={setObservedHourlyProfit} min={0} step={0.01} hint="Auto-seeded from bot history" />
        <NumberInput label="Target hourly profit ($)" value={targetHourlyProfit} onChange={setTargetHourlyProfit} min={0} step={0.01} hint="Income goal" />
      </div>

      {/* ── Edge Retention Summary ────────────────────────────── */}
      <div className="rounded-2xl border border-violet-800/50 bg-violet-950/10 p-5">
        <h2 className="mb-1 text-lg font-semibold text-violet-300">Edge Retention Analysis</h2>
        <p className="mb-4 text-xs text-zinc-500">
          How much of the current observed edge must survive as bankroll grows to hit the income target?
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard label="Observed hourly return" value={fmtPct(ed.observedHourlyReturn, 4)} sub={`${fmtPct(ed.observedDailyCompoundedReturn, 3)}/day compounded`} tone="amber" />
          <SummaryCard label="Required hourly return" value={fmtPct(ed.requiredHourlyReturn, 4)} sub={`${fmtPct(ed.requiredDailyReturn, 3)}/day compounded`} tone="violet" />
          <SummaryCard label="Required edge retention" value={fmtPct(ed.requiredEdgeRetention, 1)} sub="of observed hourly return" tone="violet" />
          <SummaryCard label="Safety margin" value={fmtX(ed.safetyMargin)} sub={`observed is ${fmtX(ed.safetyMargin)} the required edge`} tone={ed.safetyMargin >= 2 ? 'green' : ed.safetyMargin >= 1 ? 'amber' : 'red'} />
          <SummaryCard label="Annual profit target" value={fmtUsdFull(ed.targetProfit)} sub={`${targetHourlyProfit}/hr × 24h × ${days}d`} />
          <SummaryCard label="Ending bankroll target" value={fmtUsdFull(ed.endingBankrollTarget)} tone="violet" />
          <SummaryCard label="Required growth multiple" value={fmtX(ed.requiredMultiple)} sub={fmtPct(ed.requiredAnnualReturn, 1) + ' annual return'} tone="violet" />
          <SummaryCard label="Naive 1-year (100% edge)" value={fmtUsd(scenarios.find((s) => Math.abs(s.edgeRetention - 1) < 0.001)?.endingBankroll ?? 0)} sub="theoretical upper bound" tone="amber" />
        </div>

        {ed.requiredEdgeRetention > 1 && (
          <div className="mt-4 rounded-xl border border-red-700/60 bg-red-950/30 px-4 py-3 text-xs text-red-300">
            Observed edge is below the required edge for this target. The bot must improve its return rate or the target must be lowered.
          </div>
        )}

        {/* Scenario table */}
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500">
                <th className="py-2 text-left">Scenario</th>
                <th className="py-2 text-right">Effective $/hr</th>
                <th className="py-2 text-right">Daily return</th>
                <th className="py-2 text-right text-violet-300">{days}d ending bankroll</th>
                <th className="py-2 text-right">Annual return</th>
              </tr>
            </thead>
            <tbody>
              {scenariosSorted.map((s: EdgeScenario, i) => {
                const isBreakEven = Math.abs(s.edgeRetention - ed.requiredEdgeRetention) < 0.005;
                const color = SCENARIO_COLORS[i % SCENARIO_COLORS.length]!;
                return (
                  <tr key={s.label} className={`border-b ${isBreakEven ? 'border-violet-900/60 bg-violet-950/20' : 'border-zinc-900'}`}>
                    <td className="py-1.5 font-medium" style={{ color }}>{s.label}{isBreakEven ? ' ✓' : ''}</td>
                    <td className="py-1.5 text-right text-zinc-400">{fmtUsd(s.effectiveHourlyReturn * startingBankroll, 4)}/hr</td>
                    <td className="py-1.5 text-right text-zinc-400">{fmtPct(s.effectiveDailyReturn, 3)}</td>
                    <td className="py-1.5 text-right" style={{ color }}>{fmtUsdFull(s.endingBankroll)}</td>
                    <td className="py-1.5 text-right text-zinc-400">{fmtPct(s.annualReturn, 1)}</td>
                  </tr>
                );
              })}
              <tr className="border-b border-zinc-800">
                <td className="py-1.5 text-zinc-500">Linear (no compounding)</td>
                <td className="py-1.5 text-right text-zinc-500">{fmtUsd(observedHourlyProfit, 2)}/hr</td>
                <td className="py-1.5 text-right text-zinc-500">—</td>
                <td className="py-1.5 text-right text-zinc-500">{fmtUsdFull(startingBankroll + observedHourlyProfit * 24 * days)}</td>
                <td className="py-1.5 text-right text-zinc-500">{fmtPct((observedHourlyProfit * 24 * days) / startingBankroll, 1)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Advanced inputs ───────────────────────────────────── */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Risk Haircuts</h2>
          <button onClick={() => setShowAdvanced((v) => !v)} className="text-xs text-zinc-400 hover:text-zinc-200">
            {showAdvanced ? 'Hide' : 'Show'}
          </button>
        </div>
        {showAdvanced && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NumberInput label="Fee haircut (0–1)" value={feeHaircut} onChange={setFeeHaircut} min={0} max={1} step={0.001} hint="e.g. 0.001 = 0.1%" />
            <NumberInput label="Slippage haircut (0–1)" value={slippageHaircut} onChange={setSlippageHaircut} min={0} max={1} step={0.001} />
            <NumberInput label="Failure haircut (0–1)" value={failureHaircut} onChange={setFailureHaircut} min={0} max={1} step={0.01} />
            <NumberInput label="Drawdown haircut (0–1)" value={drawdownHaircut} onChange={setDrawdownHaircut} min={0} max={1} step={0.01} />
            <NumberInput label="Reinvestment rate (0–1)" value={reinvestmentRate} onChange={setReinvestmentRate} min={0} max={1} step={0.01} />
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-400">Conservative scaling (perf chart)</span>
              <select value={scalingFactor} onChange={(e) => setScalingFactor(Number(e.target.value))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
              >
                <option value={0.1}>Very conservative (0.10×)</option>
                <option value={0.25}>Conservative (0.25×)</option>
                <option value={0.5}>Moderate (0.50×)</option>
                <option value={0.75}>Aggressive (0.75×)</option>
                <option value={1}>Naive / perfect (1.00×)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={maxHourlyProfitEnabled} onChange={(e) => setMaxHourlyProfitEnabled(e.target.checked)} />
                Max hourly profit cap ($)
              </label>
              <input type="number" min={0} step={0.1} value={maxHourlyProfitVal} disabled={!maxHourlyProfitEnabled}
                onChange={(e) => setMaxHourlyProfitVal(Number(e.target.value))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500 disabled:opacity-40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={liquidityCapEnabled} onChange={(e) => setLiquidityCapEnabled(e.target.checked)} />
                Liquidity cap ($)
              </label>
              <input type="number" min={0} step={100} value={liquidityCapVal} disabled={!liquidityCapEnabled}
                onChange={(e) => setLiquidityCapVal(Number(e.target.value))}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500 disabled:opacity-40"
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Chart ─────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Edge Retention Chart</h2>
            <p className="mt-0.5 text-xs text-zinc-500">Each line shows a different fraction of observed edge surviving at scale. Bold violet = break-even.</p>
          </div>
          <div className="flex overflow-hidden rounded-lg border border-zinc-700">
            {(['linear', 'log'] as ScaleMode[]).map((m) => (
              <button key={m} onClick={() => setScaleMode(m)}
                className={`px-3 py-1 text-xs transition ${scaleMode === m ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                {m === 'log' ? 'Log scale' : 'Linear scale'}
              </button>
            ))}
          </div>
        </div>

        {/* Legend / toggles */}
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          {scenariosSorted.map((s, i) => {
            const color = SCENARIO_COLORS[i % SCENARIO_COLORS.length]!;
            const isBreakEven = Math.abs(s.edgeRetention - ed.requiredEdgeRetention) < 0.005;
            return (
              <button key={s.label} onClick={() => toggleSeries(s.label)}
                className={`flex items-center gap-1.5 rounded px-2 py-1 transition hover:bg-zinc-800 ${visibleSeries[s.label] === false ? 'opacity-40' : ''}`}
              >
                <span className="h-2 w-5 rounded-sm" style={{ backgroundColor: color, outline: isBreakEven ? '2px solid ' + color : 'none' }} />
                <span className="text-zinc-400">{s.label}</span>
              </button>
            );
          })}
          <button onClick={() => toggleSeries('linear')}
            className={`flex items-center gap-1.5 rounded px-2 py-1 transition hover:bg-zinc-800 ${visibleSeries.linear === false ? 'opacity-40' : ''}`}
          >
            <span className="h-2 w-5 rounded-sm bg-zinc-500" />
            <span className="text-zinc-400">Linear</span>
          </button>
          <button onClick={() => toggleSeries('actual')}
            className={`flex items-center gap-1.5 rounded px-2 py-1 transition hover:bg-zinc-800 ${visibleSeries.actual === false ? 'opacity-40' : ''}`}
          >
            <span className="h-2 w-5 rounded-sm bg-green-500" />
            <span className="text-zinc-400">Actual PnL</span>
          </button>
          <span className="ml-1 self-center text-zinc-600">click to toggle</span>
        </div>

        <div ref={chartEl} className="h-[400px] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/80" />
      </div>

      {/* ── Checkpoint table ──────────────────────────────────── */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <h2 className="mb-3 text-lg font-semibold">Checkpoint Table</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500">
                <th className="py-2 text-left">Day</th>
                <th className="py-2 text-right text-zinc-400">Linear</th>
                {scenariosSorted.map((s, i) => {
                  const isBreakEven = Math.abs(s.edgeRetention - ed.requiredEdgeRetention) < 0.005;
                  return (
                    <th key={s.label} className={`py-2 text-right ${isBreakEven ? 'text-violet-400' : 'text-zinc-400'}`}
                        style={{ color: SCENARIO_COLORS[i % SCENARIO_COLORS.length] }}>
                      {s.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {ec.map((c) => (
                <tr key={c.day} className="border-b border-zinc-900">
                  <td className="py-1.5 font-medium text-zinc-300">Day {c.day}</td>
                  <td className="py-1.5 text-right text-zinc-400">{fmtUsd(c.linearBankroll)}</td>
                  {scenariosSorted.map((s, i) => {
                    const val = c.scenarios[s.label] ?? startingBankroll;
                    const isBreakEven = Math.abs(s.edgeRetention - ed.requiredEdgeRetention) < 0.005;
                    return (
                      <td key={s.label} className={`py-1.5 text-right ${isBreakEven ? 'font-semibold' : ''}`}
                          style={{ color: SCENARIO_COLORS[i % SCENARIO_COLORS.length] }}>
                        {fmtUsd(val)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Warnings ──────────────────────────────────────────── */}
      {allWarnings.length > 0 && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
          <h2 className="mb-3 text-lg font-semibold">Risk Notes</h2>
          <div className="space-y-2">
            {allWarnings.map((w, i) => (
              <div key={i} className={`rounded-lg px-4 py-3 text-sm ${
                w.severity === 'critical' ? 'border border-red-700/50 bg-red-950/30 text-red-300' :
                w.severity === 'warn' ? 'border border-amber-700/50 bg-amber-950/20 text-amber-300' :
                'border border-zinc-700 bg-zinc-950/50 text-zinc-400'
              }`}>{w.message}</div>
            ))}
            <p className="text-xs text-zinc-600">
              This is a projection tool, not financial advice or a guarantee of future returns.
            </p>
          </div>
        </div>
      )}

      {/* ── Export ────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
        <h2 className="mb-3 text-lg font-semibold">Export</h2>
        <div className="flex flex-wrap gap-3">
          <button onClick={handleExportCsv} className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition">Download CSV</button>
          <button onClick={handleExportMd} className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition">Download Markdown</button>
          <button onClick={handleExportJson} className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition">Download JSON</button>
        </div>
      </div>
    </div>
  );
}
