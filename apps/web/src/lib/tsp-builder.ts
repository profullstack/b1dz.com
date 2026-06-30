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

/** Render a single operand back to its editable string form. */
function operandToString(op: unknown): string {
  return typeof op === 'number' ? String(op) : String(op ?? '');
}

/** Flatten a TSP condition into the wizard's AND-list of comparisons. A bare
 *  comparison → one row; an `and` → its rows; `or`/`not` collapse to their
 *  inner comparisons (a lossy but editable approximation). */
function conditionToRows(cond: unknown): ComparisonRow[] {
  if (!cond || typeof cond !== 'object') return [];
  const c = cond as Record<string, unknown>;
  if (Array.isArray(c.and)) return c.and.flatMap(conditionToRows);
  if (Array.isArray(c.or)) return c.or.flatMap(conditionToRows);
  if (c.not) return conditionToRows(c.not);
  const op = Object.keys(c)[0] as Comparator | undefined;
  if (!op) return [];
  const pair = c[op];
  if (!Array.isArray(pair) || pair.length !== 2) return [];
  return [{ left: operandToString(pair[0]), op, right: operandToString(pair[1]) }];
}

/**
 * Reverse of buildDefinition: hydrate wizard state from a TSP document (e.g. one
 * the AI drafted) so the user can keep editing it in the form. Best-effort —
 * unknown shapes fall back to defaults.
 */
export function builderStateFromDefinition(doc: unknown): BuilderState {
  const base = defaultBuilderState();
  if (!doc || typeof doc !== 'object') return base;
  const d = doc as Record<string, unknown>;

  if (typeof d.id === 'string') base.id = d.id;
  if (typeof d.name === 'string') base.name = d.name;
  if (typeof d.description === 'string') base.description = d.description;
  if (Array.isArray(d.assetClasses)) {
    const classes = d.assetClasses.filter((c): c is AssetClass => c === 'crypto' || c === 'equity');
    if (classes.length) base.assetClasses = classes;
  }

  const body = d.definition as Record<string, unknown> | undefined;
  if (body?.kind === 'template') {
    const template = (['mean-reversion', 'breakout', 'trend-continuation'] as TemplateName[]).includes(body.template as TemplateName)
      ? (body.template as TemplateName)
      : 'mean-reversion';
    base.mode = 'template';
    const params = { ...TEMPLATE_PARAM_DEFAULTS[template] };
    if (body.params && typeof body.params === 'object') {
      for (const [key, val] of Object.entries(body.params as Record<string, unknown>)) {
        if (typeof val === 'number') params[key] = val;
      }
    }
    base.template = { template, params };
  } else if (body?.kind === 'rules') {
    base.mode = 'rules';
    const indicators: IndicatorRow[] = [];
    if (body.indicators && typeof body.indicators === 'object') {
      for (const [name, spec] of Object.entries(body.indicators as Record<string, { fn?: IndicatorFn; period?: number }>)) {
        indicators.push({ name, fn: (spec.fn ?? 'ema') as IndicatorFn, period: typeof spec.period === 'number' ? spec.period : 14 });
      }
    }
    const rules: RuleRow[] = Array.isArray(body.rules)
      ? (body.rules as Record<string, unknown>[]).map((r) => {
          const sig = (r.signal ?? {}) as Record<string, unknown>;
          return {
            conditions: conditionToRows(r.when),
            side: sig.side === 'sell' ? 'sell' : 'buy',
            strength: typeof sig.strength === 'number' ? sig.strength : 1,
            reason: typeof sig.reason === 'string' ? sig.reason : '',
          } as RuleRow;
        })
      : [];
    base.rules = {
      indicators: indicators.length ? indicators : base.rules.indicators,
      rules: rules.length ? rules : base.rules.rules,
    };
  }

  return base;
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
