/**
 * TSP — Trading Strategy Protocol (v0.1)
 *
 * A vendor-neutral, declarative JSON format for *signals-only* trading
 * strategies: a document reads a market-data stream and emits buy/sell signals.
 * It executes no user code — strategies are data, not programs — so untrusted,
 * user-authored definitions are safe to run and to publish.
 *
 * There is no widely-adopted open standard for this (Pine Script is a
 * proprietary DSL; QuantConnect/Backtrader are code; FIX/FIXML cover order
 * messaging, not strategy logic). TSP aims to fill that gap. The canonical JSON
 * Schema is served at https://b1dz.com/spec/tsp/v0.1/tsp.schema.json (source:
 * `apps/web/public/spec/tsp/v0.1/tsp.schema.json`); the human-readable spec is
 * `docs/specs/tsp-v0.1.md`.
 *
 * Two definition kinds, in increasing expressiveness:
 *   - `template`: a named preset (mean-reversion / breakout / trend-continuation)
 *     with tunable numeric params. The "wizard with sliders" surface.
 *   - `rules`: declared indicators + an ordered list of {when, signal} rules,
 *     where `when` is a boolean tree over comparators. The "visual rule builder"
 *     surface, and the replacement for arbitrary code.
 *
 * compile() turns any TSP document into a @b1dz/core StrategyPlugin, so the same
 * replayStrategy() backtester scores user strategies and first-party ones alike.
 */

export const TSP_VERSION = '0.1';

export type AssetClass = 'crypto' | 'equity';
export type Side = 'buy' | 'sell';

/** The signal a rule emits when its condition matches. */
export interface SignalSpec {
  side: Side;
  /** 0..1; defaults to 1 and is clamped on compile. */
  strength?: number;
  reason?: string;
}

/**
 * A declared indicator. The key it's stored under becomes its reference name in
 * conditions. All operate on the chronological mid-price series and yield the
 * latest scalar value.
 */
export type IndicatorSpec =
  | { fn: 'rsi'; period?: number } // default 14
  | { fn: 'ema'; period: number }
  | { fn: 'sma'; period: number }
  | { fn: 'macdHist'; fast?: number; slow?: number; signal?: number };

/** A condition operand: a numeric literal, the literal "price", or an indicator name. */
export type Operand = number | string;

export type ComparisonCondition =
  | { gt: [Operand, Operand] }
  | { gte: [Operand, Operand] }
  | { lt: [Operand, Operand] }
  | { lte: [Operand, Operand] }
  | { eq: [Operand, Operand] }
  | { neq: [Operand, Operand] };

/** A boolean expression tree over comparisons. */
export type Condition =
  | ComparisonCondition
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition };

export interface Rule {
  when: Condition;
  signal: SignalSpec;
}

export interface RulesDefinition {
  kind: 'rules';
  /** name → indicator. Optional; rules may compare only price/literals. */
  indicators?: Record<string, IndicatorSpec>;
  /** Evaluated top-to-bottom; the first matching rule's signal wins. */
  rules: Rule[];
}

export type TemplateName = 'mean-reversion' | 'breakout' | 'trend-continuation';

export interface TemplateDefinition {
  kind: 'template';
  template: TemplateName;
  /** Numeric overrides for the template's defaults (e.g. { period: 21 }). */
  params?: Record<string, number>;
}

export type StrategyDefinitionBody = RulesDefinition | TemplateDefinition;

export interface TradingStrategyDefinition {
  /** Protocol version, e.g. "0.1". */
  tsp: string;
  /** Stable slug, e.g. "my-rsi-dip". */
  id: string;
  name: string;
  author?: string;
  description?: string;
  /** Which asset classes the author intends; informational, not enforced. */
  assetClasses?: AssetClass[];
  definition: StrategyDefinitionBody;
}

export const COMPARATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] as const;
export type Comparator = (typeof COMPARATORS)[number];
export const INDICATOR_FNS = ['rsi', 'ema', 'sma', 'macdHist'] as const;
export const TEMPLATE_NAMES: TemplateName[] = ['mean-reversion', 'breakout', 'trend-continuation'];
