/**
 * Pure builder: turn the wizard's form state into a TSP (Trading Strategy
 * Protocol) document. Kept separate from the React page so the doc-assembly
 * logic is unit-testable in the node test environment.
 *
 * The wizard exposes a deliberately constrained subset of TSP: a template with
 * sliders, or a list of rules where each rule ANDs together a few comparisons.
 * That subset still compiles + validates as full TSP via @b1dz/source-strategies.
 */

export type BuilderMode = 'template' | 'rules';
export type TemplateName = 'mean-reversion' | 'breakout' | 'trend-continuation';
export type IndicatorFn = 'rsi' | 'ema' | 'sma' | 'macdHist';
export type Comparator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
export type Side = 'buy' | 'sell';
export type AssetClass = 'crypto' | 'equity';

export interface IndicatorRow {
  name: string;
  fn: IndicatorFn;
  period: number;
}

export interface ComparisonRow {
  left: string;
  op: Comparator;
  right: string;
}

export interface RuleRow {
  conditions: ComparisonRow[]; // ANDed together
  side: Side;
  strength: number;
  reason: string;
}

export interface BuilderState {
  id: string;
  name: string;
  description: string;
  assetClasses: AssetClass[];
  mode: BuilderMode;
  template: { template: TemplateName; params: Record<string, number> };
  rules: { indicators: IndicatorRow[]; rules: RuleRow[] };
}

/** Default numeric params per template (matches the compiler defaults). */
export const TEMPLATE_PARAM_DEFAULTS: Record<TemplateName, Record<string, number>> = {
  'mean-reversion': { period: 14, oversold: 30, overbought: 70 },
  breakout: { lookback: 20 },
  'trend-continuation': { fast: 12, slow: 26 },
};

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled-strategy';
}

export function defaultBuilderState(): BuilderState {
  return {
    id: '',
    name: '',
    description: '',
    assetClasses: ['crypto', 'equity'],
    mode: 'template',
    template: { template: 'mean-reversion', params: { ...TEMPLATE_PARAM_DEFAULTS['mean-reversion'] } },
    rules: {
      indicators: [{ name: 'rsi14', fn: 'rsi', period: 14 }],
      rules: [
        { conditions: [{ left: 'rsi14', op: 'lt', right: '30' }], side: 'buy', strength: 0.8, reason: 'oversold' },
        { conditions: [{ left: 'rsi14', op: 'gt', right: '70' }], side: 'sell', strength: 0.8, reason: 'overbought' },
      ],
    },
  };
}

/** Coerce a raw operand string: a number literal stays numeric; anything else
 *  (an indicator name or the keyword "price") stays a string. */
export function coerceOperand(raw: string): number | string {
  const trimmed = raw.trim();
  if (trimmed === '') return trimmed;
  const n = Number(trimmed);
  return Number.isFinite(n) && /^-?\d*\.?\d+$/.test(trimmed) ? n : trimmed;
}

type Comparison = Record<Comparator, [number | string, number | string]>;
type Condition = Comparison | { and: Comparison[] };

function ruleToCondition(rule: RuleRow): Condition {
  const comparisons = rule.conditions.map((c) => ({ [c.op]: [coerceOperand(c.left), coerceOperand(c.right)] }) as Comparison);
  return comparisons.length === 1 ? comparisons[0]! : { and: comparisons };
}

export interface BuiltStrategy {
  tsp: string;
  id: string;
  name: string;
  description?: string;
  assetClasses?: AssetClass[];
  definition: Record<string, unknown>;
}

/** Assemble a TSP document from builder state (no validation — that's the
 *  compiler's job; this just shapes the JSON). */
export function buildDefinition(state: BuilderState): BuiltStrategy {
  const id = state.id.trim() || slugify(state.name);
  const base: BuiltStrategy = {
    tsp: '0.1',
    id,
    name: state.name.trim() || 'Untitled Strategy',
    definition: {},
  };
  if (state.description.trim()) base.description = state.description.trim();
  if (state.assetClasses.length) base.assetClasses = state.assetClasses;

  if (state.mode === 'template') {
    base.definition = {
      kind: 'template',
      template: state.template.template,
      params: { ...state.template.params },
    };
    return base;
  }

  const indicators: Record<string, { fn: IndicatorFn; period?: number }> = {};
  for (const ind of state.rules.indicators) {
    if (!ind.name.trim()) continue;
    indicators[ind.name.trim()] = ind.fn === 'macdHist' ? { fn: ind.fn } : { fn: ind.fn, period: ind.period };
  }
  base.definition = {
    kind: 'rules',
    ...(Object.keys(indicators).length ? { indicators } : {}),
    rules: state.rules.rules.map((r) => ({
      when: ruleToCondition(r),
      signal: { side: r.side, strength: r.strength, ...(r.reason.trim() ? { reason: r.reason.trim() } : {}) },
    })),
  };
  return base;
}
