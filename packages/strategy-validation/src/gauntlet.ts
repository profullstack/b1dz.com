/**
 * The statistical gauntlet — everything a strategy must survive to earn a listing.
 *
 * Each gate is a standalone, nameable check with a blocking/non-blocking flag
 * and a pass threshold. `runGauntlet()` runs them all, records the results, and
 * returns a report whose `passed` field is true ONLY when every blocking gate
 * clears. Non-blocking gates (advisory, informational) affect the human-readable
 * summary but never block listing.
 *
 * Every gate is a pure function of its inputs. No gate throws — a caught error
 * becomes a FAILED gate with the error message in `detail`, so a single buggy
 * gate cannot abort the entire run. The gauntlet's own top-level catch does the
 * same: the report always comes back, even when something is profoundly broken.
 */
import type { MarketSnapshot } from '@b1dz/core';
import {
  DEFAULT_AMOUNT_PER_ENTRY,
  costModelForSeries,
  describeCostModel,
  replayStrategy,
  summarizeTrades,
  tsp,
  ZERO_COST_MODEL,
  type CostModel,
} from '@b1dz/source-strategies';
import { computeMetrics, tradeReturns } from './metrics.js';
import { deflatedSharpeRatio, nullVarianceOfTrialSharpes } from './deflated-sharpe.js';
import { trainTestSplit, walkForwardSplits } from './splits.js';
import { robustnessScore } from './robustness.js';
import { classifyRegimes, regimeBreakdown, regimeCoverage } from './regime.js';
import { findDuplicates, signalCorrelation } from './correlation.js';


/** A single quality gate — one yes/no decision with supporting numbers. */
export interface GauntletGate {
  /** Short, stable key for reporting and diffing across runs. */
  name: string;
  /** true → the gate cleared its threshold. */
  passed: boolean;
  /** The measured value (a probability, ratio, count, pct...). */
  value: number;
  /** Threshold that gate requires to pass. */
  threshold: number;
  /** Human-readable explanation of the result (≤ 200 chars, single line). */
  detail: string;
  /** If true and this gate fails, the whole report fails. If false, advisory. */
  blocking: boolean;
}

/** A composite summary covering every gate for one fold. */
export interface WalkForwardGateBlock {
  foldIndex: number;
  gates: GauntletGate[];
  summary: ReturnType<typeof summarizeTrades>;
}

export interface GauntletPolicy {
  /** Minimum trades for the in-sample backtest to be considered meaningful. Default 30. */
  minTrades: number;
  /** Fewer bars than this → cannot run. Below minimum warmup for the slowest TSP indicator. */
  minBars: number;
  /** Minimum fraction of the series held for out-of-sample. Default 0.3. */
  oosRatio: number;
  /** Max drawdown as fraction of peak. Default 0.25. */
  maxDrawdownPct: number;
  /** Gross wins / gross losses, net of costs. Default 1.2. */
  minProfitFactor: number;
  /** One-sided PSR confidence for the deflated Sharpe gate. Default 0.95. */
  minDeflatedSharpePValue: number;
  /** Fraction of effective robustness variants that must stay profitable. Default 0.6. */
  minRobustnessFraction: number;
  /** Ceil on how much of the base return the median robust variant may give up. Default 0.5. */
  maxRobustnessDegradationPct: number;
  /** Regimes with net profit required. Default 2. */
  minProfitableRegimes: number;
  /** Max Pearson across either signal or per-week return correlation with any
   *  catalogue entry, above which we reject as a duplicate. Default 0.8. */
  maxCatalogCorrelation: number;
  /** Require the out-of-sample return to be positive. Default true. */
  requireOutOfSampleProfit: boolean;
  /** Walk-forward folds. Default 3. */
  walkForwardFolds: number;
}

export const DEFAULT_POLICY: GauntletPolicy = {
  minTrades: 30,
  minBars: 35,
  oosRatio: 0.3,
  maxDrawdownPct: 0.25,
  minProfitFactor: 1.2,
  minDeflatedSharpePValue: 0.95,
  minRobustnessFraction: 0.6,
  maxRobustnessDegradationPct: 0.5,
  minProfitableRegimes: 2,
  maxCatalogCorrelation: 0.8,
  requireOutOfSampleProfit: true,
  walkForwardFolds: 3,
};

// ── result types ─────────────────────────────────────────────────────────────

export interface GauntletReport {
  passed: boolean;
  candidateId: string;
  /** Validation errors before any replay was attempted — the document is not executable. */
  validationErrors: string[];
  /** Gates run on the in-sample backtest. Ordered by dependency. */
  inSampleGates: GauntletGate[];
  /** Gates run on the out-of-sample backtest. */
  outOfSampleGates: GauntletGate[];
  /** Per-fold walk-forward gate blocks. Empty if no folds run. */
  walkForward: WalkForwardGateBlock[];
  /** The deflated-Sharpe numbers (computed block). */
  deflatedSharpe: ReturnType<typeof deflatedSharpeRatio> | null;
  /** Robustness block. */
  robustness: ReturnType<typeof robustnessScore> | null;
  /** Regime coverage. */
  regimeCoverageResult: ReturnType<typeof regimeCoverage> | null;
  /** Duplicate matches from the catalogue. */
  duplicates: ReturnType<typeof findDuplicates>;
  /** In-sample summary (all bars). */
  inSampleSummary: ReturnType<typeof summarizeTrades> | null;
  /** Out-of-sample summary. */
  outOfSampleSummary: ReturnType<typeof summarizeTrades> | null;
  costModel: CostModel;
  generatedAt: string; // ISO timestamp
  /** Non-blocking gates that passed — evidence, not requirement. */
  advisoryGates: GauntletGate[];
}

export interface GauntletInput {
  definition: tsp.TradingStrategyDefinition;
  snapshots: MarketSnapshot[];
  costs?: CostModel;
  policy?: Partial<GauntletPolicy>;
  /** Catalogue entries to check for duplicates. */
  catalog?: { plugin: ReturnType<typeof tsp.compile>; trades: ReturnType<typeof replayStrategy>; id: string }[];
  /** Number of candidates generated before selection. CRITICAL. Defaults to 1. */
  nTrials?: number;
  /** Per-observation variance of trial Sharpes (heterogeneous pool). Defaults to the null. */
  trialSharpes?: number[];
  candidateId?: string;
}

function gate(name: string, value: number, threshold: number, blocking: boolean, detail: string): GauntletGate {
  return { name, passed: value >= threshold, value, threshold, blocking, detail };
}

function gateLe(name: string, value: number, threshold: number, blocking: boolean, detail: string): GauntletGate {
  return { name, passed: value <= threshold, value, threshold, blocking, detail };
}

function gateBool(name: string, passed: boolean, blocking: boolean, detail: string): GauntletGate {
  // Treat threshold as 1 (must pass); value as 1 if passed, else 0.
  return { name, passed, value: passed ? 1 : 0, threshold: 1, blocking, detail };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeGate(name: string, fn: () => GauntletGate, blocking: boolean): GauntletGate {
  try {
    return fn();
  } catch (err) {
    return gate(name, 0, 1, blocking, `gate failed with error: ${errorText(err)}`);
  }
}

/** Compile the document and return a plugin. Throws on errors (caught upstream). */
function safeCompile(doc: tsp.TradingStrategyDefinition): ReturnType<typeof tsp.compile> {
  return tsp.compile(doc);
}

// ── run the gauntlet ─────────────────────────────────────────────────────────

/* eslint-disable complexity */
export function runGauntlet(input: GauntletInput): GauntletReport {
  const p: GauntletPolicy = { ...DEFAULT_POLICY, ...input.policy };
  const costs = input.costs ?? costModelForSeries(input.snapshots);
  const candidateId = input.candidateId ?? input.definition.id ?? 'unknown';
  const now = new Date().toISOString();
  const baseReport = (overrides: Partial<GauntletReport> = {}): GauntletReport => ({
    passed: false,
    candidateId,
    validationErrors: [],
    inSampleGates: [],
    outOfSampleGates: [],
    walkForward: [],
    deflatedSharpe: null,
    robustness: null,
    regimeCoverageResult: null,
    duplicates: [],
    inSampleSummary: null,
    outOfSampleSummary: null,
    costModel: costs,
    generatedAt: now,
    advisoryGates: [],
    ...overrides,
  });

  // 1. Validate the document.
  const validation = tsp.validateDefinition(input.definition);
  if (!validation.ok) {
    return baseReport({ validationErrors: validation.errors });
  }

  // 2. Compile.
  let plugin: ReturnType<typeof tsp.compile>;
  try {
    plugin = safeCompile(input.definition);
  } catch (err) {
    return baseReport({
      validationErrors: [`compile: ${errorText(err)}`],
    });
  }

  // 3. Split: train / test.
  const { inSample, outOfSample } = trainTestSplit(input.snapshots, p.oosRatio, { minBars: p.minBars });
  if (inSample.length < p.minBars) {
    return baseReport({
      inSampleGates: [gate('minBars', inSample.length, p.minBars, true, `only ${inSample.length} bars; need ${p.minBars}`)],
    });
  }

  // 4. In-sample replay.
  const isTrades = replayStrategy(plugin, inSample, { amountPerEntry: DEFAULT_AMOUNT_PER_ENTRY, costs });
  const isSummary = summarizeTrades(isTrades);
  const isMetrics = computeMetrics(isTrades);

  const inSampleGates: GauntletGate[] = [];
  inSampleGates.push(safeGate('minTrades', () =>
    gate('minTrades', isSummary.trades, p.minTrades, true, `${isSummary.trades} trades (need ≥ ${p.minTrades})`),
    true));
  inSampleGates.push(safeGate('maxDrawdownPct', () =>
    gateLe('maxDrawdownPct', isMetrics.maxDrawdownPct, p.maxDrawdownPct, true,
      `max drawdown ${(isMetrics.maxDrawdownPct * 100).toFixed(1)}% (limit ${(p.maxDrawdownPct * 100).toFixed(0)}%)`),
    true));
  inSampleGates.push(safeGate('minProfitFactor', () =>
    gate('minProfitFactor', isMetrics.profitFactor, p.minProfitFactor, true,
      `profit factor ${isMetrics.profitFactor.toFixed(2)} (need ≥ ${p.minProfitFactor})`),
    true));

  // 5. Deflated Sharpe.
  const dsr = deflatedSharpeRatio({
    observedSharpe: isMetrics.sharpePerTrade,
    nTrials: input.nTrials ?? 1,
    nObservations: isSummary.trades,
    skewness: isMetrics.skewness,
    kurtosis: isMetrics.kurtosis,
    varianceOfTrialSharpes: input.trialSharpes
      ? (() => { const m = input.trialSharpes!.reduce((a, b) => a + b, 0) / input.trialSharpes!.length; return input.trialSharpes!.reduce((s, v) => s + (v - m) ** 2, 0) / (input.trialSharpes!.length - 1); })()
      : undefined,
  });

  const dsrGate = gate('deflatedSharpeRatio', dsr.deflatedSharpeRatio, p.minDeflatedSharpePValue, true,
    `DSR ${dsr.deflatedSharpeRatio.toFixed(3)} (need ≥ ${p.minDeflatedSharpePValue}) — PSR=${dsr.probabilisticSharpeRatio.toFixed(3)} bar=${dsr.expectedMaxSharpe.toFixed(3)} nTrials=${dsr.nTrials}`);
  inSampleGates.push(dsrGate);

  // 6. Robustness (in-sample).
  let robustness: ReturnType<typeof robustnessScore> | null = null;
  try {
    robustness = robustnessScore(input.definition, inSample, {
      costs,
      minFractionProfitable: p.minRobustnessFraction,
      maxDegradationPct: p.maxRobustnessDegradationPct,
    });
  } catch (err) {
    inSampleGates.push(gate('robustness', 0, 1, true, `robustness error: ${errorText(err)}`));
  }
  if (robustness) {
    inSampleGates.push(gateBool('robustness', robustness.passed, true,
      robustness.detail));
  }

  // 7. Regime coverage (in-sample).
  let regimeResult: ReturnType<typeof regimeCoverage> | null = null;
  try {
    const regimes = classifyRegimes(inSample);
    const breakdown = regimeBreakdown(isTrades, regimes, inSample);
    regimeResult = regimeCoverage(breakdown, p.minProfitableRegimes);
    inSampleGates.push(gateBool('regimeCoverage', regimeResult.passed, true,
      `${regimeResult.profitableRegimes.length} profitable regimes (need ≥ ${p.minProfitableRegimes}): ${regimeResult.profitableRegimes.join(', ') || 'none'}`));
  } catch (err) {
    inSampleGates.push(gate('regimeCoverage', 0, 1, true, `regime error: ${errorText(err)}`));
  }

  // 8. Out-of-sample.
  const outOfSampleGates: GauntletGate[] = [];
  let oosSummary: ReturnType<typeof summarizeTrades> | null = null;
  if (outOfSample.length >= p.minBars) {
    const oosTrades = replayStrategy(plugin, outOfSample, { amountPerEntry: DEFAULT_AMOUNT_PER_ENTRY, costs });
    oosSummary = summarizeTrades(oosTrades);
    const oosMetrics = computeMetrics(oosTrades);

    if (p.requireOutOfSampleProfit) {
      outOfSampleGates.push(gateBool('outOfSampleProfit', oosSummary.returnPct > 0, true,
        `OOS return ${(oosSummary.returnPct * 100).toFixed(2)}% (need > 0)`));
    }
    outOfSampleGates.push(gateLe('outOfSampleMaxDrawdownPct', oosMetrics.maxDrawdownPct, p.maxDrawdownPct, false,
      `OOS max drawdown ${(oosMetrics.maxDrawdownPct * 100).toFixed(1)}% (limit ${(p.maxDrawdownPct * 100).toFixed(0)}%)`));
  } else if (outOfSample.length > 0) {
    outOfSampleGates.push(gate('oosMinBars', outOfSample.length, p.minBars, true,
      `OOS only ${outOfSample.length} bars; need ${p.minBars}`));
  }

  // 9. Walk-forward.
  const wfSplits = walkForwardSplits(input.snapshots, {
    folds: p.walkForwardFolds,
    trainRatio: 0.6,
    minBars: p.minBars,
  });
  const walkForward: WalkForwardGateBlock[] = [];
  for (const fold of wfSplits) {
    const testTrades = replayStrategy(plugin, fold.test, { amountPerEntry: DEFAULT_AMOUNT_PER_ENTRY, costs });
    const testSummary = summarizeTrades(testTrades);
    const gates: GauntletGate[] = [];
    gates.push(gateBool(`wf-f${fold.index}Profit`, testSummary.returnPct > 0, false,
      `fold ${fold.index} OOS return ${(testSummary.returnPct * 100).toFixed(2)}%`));
    walkForward.push({ foldIndex: fold.index, gates, summary: testSummary });
  }

  // 10. Duplicate check.
  let duplicates: ReturnType<typeof findDuplicates> = [];
  if (input.catalog && input.catalog.length > 0) {
    try {
      duplicates = findDuplicates(plugin, isTrades, input.catalog, input.snapshots, p.maxCatalogCorrelation);
    } catch {
      // non-blocking; catalogue may change under us
    }
  }
  const dupGate = gateLe('catalogCorrelation', duplicates.length, 0, true,
    duplicates.length === 0
      ? 'no catalogue duplicates found'
      : `correlated with: ${duplicates.map((d) => d.strategyId).join(', ')}`);
  if (duplicates.length > 0) inSampleGates.push(dupGate);

  // 11. Advisory gates.
  const advisoryGates: GauntletGate[] = [
    ...outOfSampleGates.filter((g) => !g.blocking),
  ];
  // Walk-forward is advisory.
  for (const block of walkForward) {
    advisoryGates.push(...block.gates);
  }

  const blockingGates = [
    ...inSampleGates.filter((g) => g.blocking),
    ...outOfSampleGates.filter((g) => g.blocking),
  ];
  const passed = blockingGates.length > 0 && blockingGates.every((g) => g.passed);

  return {
    passed,
    candidateId,
    validationErrors: [],
    inSampleGates,
    outOfSampleGates: outOfSampleGates.filter((g) => g.blocking),
    walkForward,
    deflatedSharpe: dsr,
    robustness,
    regimeCoverageResult: regimeResult,
    duplicates,
    inSampleSummary: isSummary,
    outOfSampleSummary: oosSummary,
    costModel: costs,
    generatedAt: now,
    advisoryGates,
  };
}
/* eslint-enable complexity */

/** Render the gauntlet report as a human-readable multi-line string. */
export function explainReport(report: GauntletReport): string {
  const lines: string[] = [];
  lines.push(`Gauntlet: ${report.candidateId} — ${report.passed ? 'PASSED' : 'FAILED'}`);
  lines.push(`  generated: ${report.generatedAt}`);
  lines.push(`  costs: ${describeCostModel(report.costModel, DEFAULT_AMOUNT_PER_ENTRY)}`);

  if (report.validationErrors.length > 0) {
    lines.push('\n  VALIDATION ERRORS:');
    for (const e of report.validationErrors) lines.push(`    - ${e}`);
  }

  const render = (label: string, gates: GauntletGate[]): void => {
    if (gates.length === 0) return;
    lines.push(`\n  ${label}:`);
    for (const g of gates) {
      const mark = g.passed ? '+' : '!';
      const block = g.blocking ? '' : ' (advisory)';
      lines.push(`    ${mark} ${g.name}: ${g.detail}${block}`);
    }
  };

  render('IN-SAMPLE GATES', report.inSampleGates);
  render('OUT-OF-SAMPLE GATES', report.outOfSampleGates);

  if (report.deflatedSharpe) {
    const d = report.deflatedSharpe;
    lines.push(`\n  DEFLATED SHARPE:`);
    lines.push(`    DSR: ${d.deflatedSharpeRatio.toFixed(6)}  |  PSR(0): ${d.probabilisticSharpeRatio.toFixed(6)}`);
    lines.push(`    observed Sharpe (per-trade): ${d.observedSharpe.toFixed(6)}  |  benchmark: ${d.expectedMaxSharpe.toFixed(6)}`);
    lines.push(`    nTrials: ${d.nTrials}  |  nObs: ${d.nObservations}  |  z: ${d.zScore.toFixed(3)}`);
  }

  if (report.robustness) {
    const r = report.robustness;
    lines.push(`\n  ROBUSTNESS: ${r.passed ? 'PASSED' : 'FAILED'}`);
    lines.push(`    base return: ${(r.baseReturnPct * 100).toFixed(2)}%  |  median variant: ${(r.medianReturnPct * 100).toFixed(2)}%`);
    lines.push(`    ${r.fractionProfitable * 100}% of ${r.effectiveVariants} effective variants profitable`);
    lines.push(`    degradation: ${(r.degradationPct * 100).toFixed(0)}%`);
  }

  if (report.regimeCoverageResult) {
    const rc = report.regimeCoverageResult;
    lines.push(`\n  REGIME COVERAGE: ${rc.passed ? 'PASSED' : 'FAILED'}`);
    for (const b of rc.breakdown) {
      if (b.trades === 0) continue;
      lines.push(`    ${b.regime.padEnd(10)} ${b.trades} trades  net ${b.netProfit > 0 ? '+' : '-'}$${Math.abs(b.netProfit).toFixed(2)}  wr ${(b.winRate * 100).toFixed(0)}%`);
    }
  }

  if (report.walkForward.length > 0) {
    lines.push(`\n  WALK-FORWARD:`);
    for (const block of report.walkForward) {
      lines.push(`    fold ${block.foldIndex}: ${block.gates.map((g) => g.detail).join(' | ')}`);
    }
  }

  return lines.join('\n');
}
