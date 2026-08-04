/**
 * Parameter robustness — does the strategy survive a small nudge to its own
 * numbers, or is it balanced on a knife edge?
 *
 * WHY THIS EXISTS
 *
 * An RSI-14 mean-reversion strategy that returns 40% at period 14, 38% at 13 and
 * 41% at 15 has found something. The same strategy returning 40% at period 14,
 * −3% at 13 and −5% at 15 has found nothing: it has memorised where the noise
 * happened to line up. There is no economic mechanism that turns on at 14 and off
 * at 13. Every real edge sits on a broad plateau in parameter space, because it
 * is driven by something structural — a liquidity pattern, a behavioural bias, a
 * flow imbalance — and structure does not have a resolution of one bar.
 *
 * This is the cheapest and most reliable overfitting detector we have. It needs no
 * distributional assumptions, no out-of-sample data, and no knowledge of how many
 * candidates were generated. It just asks the search process to prove it found a
 * region rather than a point. An AI generator sweeping periods 2..50 across six
 * templates WILL produce spikes, by construction — they are the single most
 * common artifact of automated strategy search, and they are invisible in any
 * summary statistic of the base configuration alone.
 *
 * WHAT IT PERTURBS
 *
 * Every numeric knob reachable in the TSP document, in both directions:
 *   - `TemplateDefinition.params` — period, lookback, oversold, overbought, …
 *   - indicator windows in `RulesDefinition.indicators` — period / fast / slow / signal
 *   - numeric literals inside `Condition` comparison operands — the RSI 30 in
 *     `{ lt: ['rsi', 30] }`, which is exactly the kind of number a generator tunes
 *
 * Indicator windows are integers, so they are rounded and floored at 2; a "±10%"
 * nudge to a 14-period window means 13 or 15. Continuous thresholds scale
 * proportionally. A literal 0 is left alone: `{ gt: ['macdHist', 0] }` is a sign
 * test, not a fitted threshold, scaling it is a no-op, and shifting it by an
 * arbitrary absolute amount would invent a parameter with no units.
 *
 * THE GAMING VECTOR THIS CLOSES
 *
 * A knob the compiler ignores — `params: { period: 14 }` on a `breakout` template,
 * which reads `lookback` — produces a variant that is byte-identical in behaviour
 * to the base. Count those as passing variants and any document can pad its
 * robustness score to 100% with decorative numbers. So variants whose trade stream
 * is indistinguishable from the base are marked `identicalToBase` and excluded
 * from the score entirely: a parameter that changes nothing is not a parameter.
 *
 * The input document is never mutated. Every variant is a deep clone.
 */
import type { MarketSnapshot } from '@b1dz/core';
import {
  DEFAULT_AMOUNT_PER_ENTRY,
  costModelForSeries,
  replayStrategy,
  summarizeTrades,
  tsp,
  type BacktestTrade,
  type CostModel,
} from '@b1dz/source-strategies';

/** Default nudge applied to every numeric parameter, in both directions. */
export const DEFAULT_PERTURBATION_PCT = 0.1;

/**
 * Hard cap on the number of variants replayed.
 *
 * `replayStrategy()` re-slices the whole history on every bar, so a replay is
 * O(bars²). A document with 12 knobs generates 24 variants; at 2,000 bars that is
 * already tens of millions of element copies. The cap keeps a single gauntlet run
 * bounded, and knobs are taken in document order so the result stays
 * deterministic rather than depending on which ones happen to be cheap.
 */
export const DEFAULT_MAX_VARIANTS = 48;

/** Path segments of a numeric knob inside a TSP document. */
export type KnobPath = (string | number)[];

export interface DefinitionVariant {
  /** Human-readable description of the single change, e.g. `params.period 14→15 (+10%)`. */
  label: string;
  definition: tsp.TradingStrategyDefinition;
  path: KnobPath;
  from: number;
  to: number;
}

export interface Knob {
  path: KnobPath;
  /** Rendered path, e.g. `definition.rules[0].when.lt[1]`. */
  label: string;
  value: number;
  /** Indicator windows are bar counts: integral and at least 2. */
  integer: boolean;
}

/** Template/indicator keys that are bar counts rather than continuous levels. */
const WINDOW_KEYS = new Set(['period', 'lookback', 'fast', 'slow', 'signal', 'length', 'window']);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * TSP documents are pure JSON by definition (see osd/types.ts), so a JSON round
 * trip is an exact deep clone. It also strips any prototype pollution or
 * non-serializable junk riding along on an untrusted, user-authored document,
 * which `structuredClone` would faithfully preserve.
 */
export function cloneDefinition<T>(doc: T): T {
  return JSON.parse(JSON.stringify(doc)) as T;
}

/** Render a knob path as a JS-ish accessor for the variant label. */
function renderPath(path: KnobPath): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? seg : `.${seg}`;
  }
  return out;
}

function setAtPath(root: unknown, path: KnobPath, value: number): void {
  let node = root as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    node = node[path[i]!] as Record<string | number, unknown>;
  }
  node[path[path.length - 1]!] = value;
}

/** Collect numeric literals from a condition tree, recording their exact paths. */
function collectConditionKnobs(cond: unknown, path: KnobPath, out: Knob[], depth = 0): void {
  if (depth > 32 || typeof cond !== 'object' || cond === null) return;
  const obj = cond as Record<string, unknown>;

  if (Array.isArray(obj.and)) {
    obj.and.forEach((c, i) => collectConditionKnobs(c, [...path, 'and', i], out, depth + 1));
    return;
  }
  if (Array.isArray(obj.or)) {
    obj.or.forEach((c, i) => collectConditionKnobs(c, [...path, 'or', i], out, depth + 1));
    return;
  }
  if (obj.not !== undefined) {
    collectConditionKnobs(obj.not, [...path, 'not'], out, depth + 1);
    return;
  }
  for (const cmp of tsp.COMPARATORS) {
    const operands = obj[cmp];
    if (!Array.isArray(operands)) continue;
    operands.forEach((operand, i) => {
      // A literal 0 is a sign test, not a fitted level — see the file header.
      if (isNum(operand) && operand !== 0) {
        const p = [...path, cmp, i];
        out.push({ path: p, label: renderPath(p), value: operand, integer: false });
      }
    });
    return;
  }
}

/**
 * Every numeric knob in a TSP document, in stable document order.
 *
 * Exported because "which numbers is this strategy actually fitted on" is a
 * useful question on its own — a document with 11 tuned constants and 40 trades
 * is over-parameterised before any statistic is computed.
 */
export function collectKnobs(doc: tsp.TradingStrategyDefinition): Knob[] {
  const out: Knob[] = [];
  // Walked structurally rather than by narrowing the union: `perturbDefinition`
  // has to handle documents that came off the wire and may not match the declared
  // shape, and a `kind` we don't recognise must yield zero knobs, not a throw.
  const body = doc.definition as unknown as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return out;

  if (body.kind === 'template') {
    const params = body.params;
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
        if (!isNum(value) || value === 0) continue;
        const path: KnobPath = ['definition', 'params', key];
        out.push({ path, label: renderPath(path), value, integer: WINDOW_KEYS.has(key) });
      }
    }
    return out;
  }

  if (body.kind === 'rules') {
    const indicators = body.indicators;
    if (indicators && typeof indicators === 'object' && !Array.isArray(indicators)) {
      for (const [name, spec] of Object.entries(indicators as Record<string, unknown>)) {
        if (!spec || typeof spec !== 'object') continue;
        for (const key of ['period', 'fast', 'slow', 'signal']) {
          const value = (spec as Record<string, unknown>)[key];
          if (!isNum(value) || value === 0) continue;
          const path: KnobPath = ['definition', 'indicators', name, key];
          out.push({ path, label: renderPath(path), value, integer: true });
        }
      }
    }
    const rules = body.rules;
    if (Array.isArray(rules)) {
      rules.forEach((rule, i) => {
        if (!rule || typeof rule !== 'object') return;
        collectConditionKnobs(
          (rule as Record<string, unknown>).when,
          ['definition', 'rules', i, 'when'],
          out,
        );
      });
    }
  }
  return out;
}

export interface PerturbOptions {
  /** Fractional nudge applied in both directions. Default 0.1 (±10%). */
  pct?: number;
  /** Cap on returned variants. Default `DEFAULT_MAX_VARIANTS`. */
  maxVariants?: number;
}

/**
 * Deep-cloned variants of `doc`, each with exactly ONE numeric parameter nudged
 * by ±`pct`.
 *
 * One knob at a time, on purpose. Perturbing several at once tests a random
 * corner of a high-dimensional space and confounds the result — when a
 * multi-knob variant collapses you cannot tell which parameter was the fragile
 * one, and the fragile one is the finding. One-at-a-time is a local sensitivity
 * analysis, which is precisely the question "is this a plateau or a spike".
 */
export function perturbDefinition(
  doc: tsp.TradingStrategyDefinition,
  opts: PerturbOptions = {},
): DefinitionVariant[] {
  const pct = Number.isFinite(opts.pct) && (opts.pct ?? 0) > 0 ? opts.pct! : DEFAULT_PERTURBATION_PCT;
  const maxVariants = Math.max(0, Math.floor(opts.maxVariants ?? DEFAULT_MAX_VARIANTS));
  const knobs = collectKnobs(doc);
  const out: DefinitionVariant[] = [];
  const seen = new Set<string>();

  for (const knob of knobs) {
    for (const dir of [-1, 1] as const) {
      if (out.length >= maxVariants) return out;

      const raw = knob.value * (1 + dir * pct);
      const to = knob.integer ? Math.max(2, Math.round(raw)) : raw;
      // Rounding can land back on the original value (period 2 at ±10%); a
      // variant identical to the base tests nothing.
      if (to === knob.value) continue;

      const sign = dir > 0 ? '+' : '-';
      const label = `${knob.label} ${knob.value}→${round4(to)} (${sign}${(pct * 100).toFixed(0)}%)`;
      if (seen.has(label)) continue;
      seen.add(label);

      const definition = cloneDefinition(doc);
      setAtPath(definition, knob.path, to);
      out.push({ label, definition, path: knob.path, from: knob.value, to });
    }
  }
  return out;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

// ── scoring ─────────────────────────────────────────────────────────────────

export interface RobustnessOptions extends PerturbOptions {
  amountPerEntry?: number;
  costs?: CostModel;
  /** Fraction of effective variants that must stay profitable. Default 0.6. */
  minFractionProfitable?: number;
  /** Ceiling on how much of the base return the median variant may give up. Default 0.5. */
  maxDegradationPct?: number;
}

export interface RobustnessVariantResult {
  label: string;
  returnPct: number;
  trades: number;
  profitable: boolean;
  /**
   * True when this variant produced the same trade stream as the base — i.e. the
   * perturbed parameter has no effect on the compiled strategy. Excluded from
   * every score; see the file header.
   */
  identicalToBase: boolean;
  /** Set when the variant failed to compile or replay. Counts as unprofitable. */
  error?: string;
}

export interface RobustnessReport {
  baseReturnPct: number;
  baseTrades: number;
  variants: RobustnessVariantResult[];
  /** Variants that actually changed behaviour — the denominator for every score. */
  effectiveVariants: number;
  medianReturnPct: number;
  worstReturnPct: number;
  fractionProfitable: number;
  /**
   * Share of the base return given up by the MEDIAN variant.
   * 0 = the neighbourhood performs like the base. 1 = the median gave up the
   * entire edge. >1 = it flipped to a loss. NEGATIVE is a good sign: the base is
   * not the local peak, so nothing was tuned to a spike.
   */
  degradationPct: number;
  passed: boolean;
  detail: string;
}

/** Behavioural signature of a replay, for spotting no-op parameters. */
function signature(trades: BacktestTrade[]): string {
  let profit = 0;
  for (const t of trades) profit += t.profit;
  return `${trades.length}:${profit.toFixed(6)}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function emptyReport(detail: string): RobustnessReport {
  return {
    baseReturnPct: 0,
    baseTrades: 0,
    variants: [],
    effectiveVariants: 0,
    medianReturnPct: 0,
    worstReturnPct: 0,
    fractionProfitable: 0,
    degradationPct: 0,
    passed: false,
    detail,
  };
}

/**
 * Replay the base document and every ±`pct` variant over the same bars and the
 * same cost model, and score the neighbourhood.
 *
 * Fails CLOSED in every degenerate case, including the one that looks like a
 * technicality: a document with no effective knobs scores `passed: false`. We
 * cannot demonstrate robustness for it, so we do not claim it. In practice every
 * TSP strategy has at least one indicator window, so the only documents this
 * rejects are ones whose numbers the compiler ignores — which is a defect worth
 * surfacing, not papering over.
 */
export function robustnessScore(
  doc: tsp.TradingStrategyDefinition,
  snapshots: MarketSnapshot[],
  opts: RobustnessOptions = {},
): RobustnessReport {
  const amountPerEntry = opts.amountPerEntry ?? DEFAULT_AMOUNT_PER_ENTRY;
  const costs = opts.costs ?? costModelForSeries(snapshots);
  const minFraction = opts.minFractionProfitable ?? 0.6;
  const maxDegradation = opts.maxDegradationPct ?? 0.5;

  let baseTrades: BacktestTrade[];
  try {
    baseTrades = replayStrategy(tsp.compile(doc), snapshots, { amountPerEntry, costs });
  } catch (err) {
    return emptyReport(`base definition failed to compile: ${errorText(err)}`);
  }

  const baseSummary = summarizeTrades(baseTrades);
  const baseSignature = signature(baseTrades);
  const variantDocs = perturbDefinition(doc, opts);

  const variants: RobustnessVariantResult[] = variantDocs.map((v) => {
    try {
      const trades = replayStrategy(tsp.compile(v.definition), snapshots, { amountPerEntry, costs });
      const summary = summarizeTrades(trades);
      return {
        label: v.label,
        returnPct: summary.returnPct,
        trades: summary.trades,
        profitable: summary.returnPct > 0,
        identicalToBase: signature(trades) === baseSignature,
      };
    } catch (err) {
      // A variant that cannot even be compiled is not robust. Count it as a loss
      // rather than dropping it, or an invalid neighbourhood would look clean.
      return {
        label: v.label,
        returnPct: 0,
        trades: 0,
        profitable: false,
        identicalToBase: false,
        error: errorText(err),
      };
    }
  });

  const effective = variants.filter((v) => !v.identicalToBase);
  if (effective.length === 0) {
    return {
      ...emptyReport(
        variants.length === 0
          ? 'no numeric parameters to perturb — robustness cannot be demonstrated'
          : `all ${variants.length} perturbations left behaviour unchanged — the document's numbers do not reach the compiled strategy`,
      ),
      baseReturnPct: baseSummary.returnPct,
      baseTrades: baseSummary.trades,
      variants,
    };
  }

  const returns = effective.map((v) => v.returnPct);
  const medianReturnPct = median(returns);
  const worstReturnPct = Math.min(...returns);
  const fractionProfitable = effective.filter((v) => v.profitable).length / effective.length;
  const degradationPct = computeDegradation(baseSummary.returnPct, medianReturnPct);
  const passed = fractionProfitable >= minFraction && degradationPct <= maxDegradation;

  return {
    baseReturnPct: baseSummary.returnPct,
    baseTrades: baseSummary.trades,
    variants,
    effectiveVariants: effective.length,
    medianReturnPct,
    worstReturnPct,
    fractionProfitable,
    degradationPct,
    passed,
    detail: `${(fractionProfitable * 100).toFixed(0)}% of ${effective.length} effective ±${(((opts.pct ?? DEFAULT_PERTURBATION_PCT) * 100)).toFixed(0)}% variants profitable; median gives up ${(degradationPct * 100).toFixed(0)}% of the base return`,
  };
}

/**
 * Degradation as a share of the base return, clamped to a reportable range.
 *
 * A base return of ~0 makes the ratio explode, and a base return of exactly 0
 * makes it undefined. Both mean the same thing — there is no edge to degrade —
 * and the profit gates already reject that case, so this returns 0 rather than a
 * number that would dominate a report with noise.
 */
function computeDegradation(baseReturnPct: number, medianReturnPct: number): number {
  const scale = Math.abs(baseReturnPct);
  if (!(scale > 1e-9)) return 0;
  const raw = (baseReturnPct - medianReturnPct) / scale;
  return Math.min(Math.max(raw, -100), 100);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
