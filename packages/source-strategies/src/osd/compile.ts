/**
 * Compile a TSP document into a @b1dz/core StrategyPlugin.
 *
 * The compiled plugin is signals-only and asset-agnostic, exactly like the
 * hand-written first-party strategies — so replayStrategy() backtests a
 * user-authored TSP doc the same way it backtests the built-ins. No user code
 * runs: `template` maps to a parameterized built-in, `rules` is interpreted by a
 * small, total evaluator over declared indicators.
 */
import type { StrategyPlugin, Signal } from '@b1dz/core';
import { rsi, ema, sma, macd } from '@b1dz/core';
import { midSeries, clamp01 } from '../helpers.js';
import { assertDefinition } from './validate.js';
import type {
  Comparator,
  Condition,
  IndicatorSpec,
  Operand,
  RulesDefinition,
  SignalSpec,
  TemplateDefinition,
  TradingStrategyDefinition,
} from './types.js';

function toSignal(spec: SignalSpec): Signal {
  return {
    side: spec.side,
    strength: clamp01(spec.strength ?? 1),
    reason: spec.reason ?? `${spec.side} rule matched`,
  };
}

// ── rules interpreter ───────────────────────────────────────────────────────

/** Latest scalar value of a declared indicator over the mid series. */
function indicatorValue(spec: IndicatorSpec, series: number[]): number {
  switch (spec.fn) {
    case 'rsi':
      return rsi(series, spec.period ?? 14);
    case 'ema':
      return ema(series, spec.period).at(-1) ?? 0;
    case 'sma':
      return sma(series, spec.period);
    case 'macdHist':
      return macd(series, spec.fast ?? 12, spec.slow ?? 26, spec.signal ?? 9).histogram;
  }
}

/** Bars needed before an indicator is meaningful (so we can return null early). */
function indicatorMinPoints(spec: IndicatorSpec): number {
  switch (spec.fn) {
    case 'rsi':
      return (spec.period ?? 14) + 1;
    case 'ema':
    case 'sma':
      return spec.period;
    case 'macdHist':
      return (spec.slow ?? 26) + (spec.signal ?? 9);
  }
}

function resolveOperand(op: Operand, series: number[], env: Record<string, number>): number {
  if (typeof op === 'number') return op;
  if (op === 'price') return series.at(-1) ?? 0;
  const v = env[op];
  if (v === undefined) throw new Error(`unknown operand "${op}"`);
  return v;
}

const COMPARATOR_FNS: Record<Comparator, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
};

function evalCondition(cond: Condition, series: number[], env: Record<string, number>): boolean {
  if ('and' in cond) return cond.and.every((c) => evalCondition(c, series, env));
  if ('or' in cond) return cond.or.some((c) => evalCondition(c, series, env));
  if ('not' in cond) return !evalCondition(cond.not, series, env);
  // comparison: exactly one comparator key (guaranteed by validation)
  const key = Object.keys(cond)[0] as Comparator;
  const [left, right] = (cond as Record<string, [Operand, Operand]>)[key]!;
  return COMPARATOR_FNS[key](resolveOperand(left, series, env), resolveOperand(right, series, env));
}

function compileRules(meta: TradingStrategyDefinition, body: RulesDefinition): StrategyPlugin {
  const indicators = body.indicators ?? {};
  const minPoints = Math.max(
    2,
    ...Object.values(indicators).map(indicatorMinPoints),
  );

  return {
    manifest: {
      id: meta.id,
      kind: 'strategy',
      version: meta.tsp,
      name: meta.name,
      author: meta.author,
      description: meta.description,
      capabilities: ['style:custom', 'protocol:tsp', ...(meta.assetClasses ?? ['crypto', 'equity']).map((a) => `asset:${a}`)],
    },
    evaluate(snap, history): Signal | null {
      const series = midSeries(snap, history);
      if (series.length < minPoints) return null;

      const env: Record<string, number> = {};
      for (const [name, spec] of Object.entries(indicators)) {
        env[name] = indicatorValue(spec, series);
      }
      for (const rule of body.rules) {
        if (evalCondition(rule.when, series, env)) return toSignal(rule.signal);
      }
      return null;
    },
  };
}

// ── templates (parameterized built-ins) ─────────────────────────────────────

function num(params: Record<string, number> | undefined, key: string, fallback: number): number {
  const v = params?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function compileTemplate(meta: TradingStrategyDefinition, body: TemplateDefinition): StrategyPlugin {
  const p = body.params;
  const capabilities = (meta.assetClasses ?? ['crypto', 'equity']).map((a) => `asset:${a}`);
  const base = {
    id: meta.id,
    kind: 'strategy' as const,
    version: meta.tsp,
    name: meta.name,
    author: meta.author,
    description: meta.description,
  };

  if (body.template === 'mean-reversion') {
    const period = num(p, 'period', 14);
    const oversold = num(p, 'oversold', 30);
    const overbought = num(p, 'overbought', 70);
    return {
      manifest: { ...base, capabilities: ['style:mean-reversion', 'protocol:tsp', ...capabilities] },
      evaluate(snap, history) {
        const series = midSeries(snap, history);
        if (series.length < period + 1) return null;
        const r = rsi(series, period);
        if (r <= oversold) return { side: 'buy', strength: clamp01((oversold - r) / oversold), reason: `RSI ${r.toFixed(1)} oversold` };
        if (r >= overbought) return { side: 'sell', strength: clamp01((r - overbought) / (100 - overbought)), reason: `RSI ${r.toFixed(1)} overbought` };
        return null;
      },
    };
  }

  if (body.template === 'breakout') {
    const lookback = num(p, 'lookback', 20);
    return {
      manifest: { ...base, capabilities: ['style:breakout', 'protocol:tsp', ...capabilities] },
      evaluate(snap, history) {
        const series = midSeries(snap, history);
        if (series.length < lookback + 1) return null;
        const current = series.at(-1)!;
        const window = series.slice(-(lookback + 1), -1);
        const hi = Math.max(...window);
        const lo = Math.min(...window);
        if (current > hi) return { side: 'buy', strength: clamp01(((current - hi) / (hi || 1)) * 100), reason: `broke ${lookback}-bar high` };
        if (current < lo) return { side: 'sell', strength: clamp01(((lo - current) / (lo || 1)) * 100), reason: `broke ${lookback}-bar low` };
        return null;
      },
    };
  }

  // trend-continuation
  const fast = num(p, 'fast', 12);
  const slow = num(p, 'slow', 26);
  return {
    manifest: { ...base, capabilities: ['style:trend', 'protocol:tsp', ...capabilities] },
    evaluate(snap, history) {
      const series = midSeries(snap, history);
      if (series.length < slow + 9) return null;
      const f = ema(series, fast).at(-1)!;
      const s = ema(series, slow).at(-1)!;
      const m = macd(series, fast, slow);
      const spread = Math.abs(f - s) / (s || 1);
      if (f > s && m.histogram > 0) return { side: 'buy', strength: clamp01(spread * 50 * (m.histogram > m.prevHistogram ? 1 : 0.6)), reason: 'fast EMA > slow EMA, MACD positive' };
      if (f < s && m.histogram < 0) return { side: 'sell', strength: clamp01(spread * 50 * (m.histogram < m.prevHistogram ? 1 : 0.6)), reason: 'fast EMA < slow EMA, MACD negative' };
      return null;
    },
  };
}

/**
 * Validate and compile a TSP document into a runnable StrategyPlugin.
 * Throws (with readable errors) if the document is invalid.
 */
export function compile(doc: unknown): StrategyPlugin {
  const meta = assertDefinition(doc);
  return meta.definition.kind === 'template'
    ? compileTemplate(meta, meta.definition)
    : compileRules(meta, meta.definition);
}
