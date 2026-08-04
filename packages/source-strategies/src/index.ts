/**
 * @b1dz/source-strategies — deterministic, asset-agnostic StrategyPlugins.
 *
 * Three families from the equities-v1 PRD §8, each running unchanged on crypto
 * and equity snapshots: trend continuation, mean reversion, breakout/breakdown.
 * Signals-only; the engine owns sizing, risk, session gating, and execution.
 */
import type { StrategyPlugin } from '@b1dz/core';
import { trendContinuation } from './trend-continuation.js';
import { meanReversion } from './mean-reversion.js';
import { breakout } from './breakout.js';

export { trendContinuation } from './trend-continuation.js';
export { meanReversion } from './mean-reversion.js';
export { breakout } from './breakout.js';
export * from './helpers.js';
export * from './costs.js';
export * from './backtest.js';
export * as tsp from './osd/index.js';

/** All strategy plugins this package ships, in catalog order. */
export const STRATEGY_PLUGINS: StrategyPlugin[] = [trendContinuation, meanReversion, breakout];
