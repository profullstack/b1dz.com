/**
 * TSP — Trading Strategy Protocol.
 *
 * An open, declarative JSON protocol for signals-only equities & crypto trading
 * strategies. See `docs/specs/tsp-v0.1.md` and
 * `schema/tsp-0.1.schema.json`.
 */
export * from './types.js';
export { validateDefinition, assertDefinition, type ValidationResult } from './validate.js';
export { compile } from './compile.js';
