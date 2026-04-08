/**
 * Source<TItem, TOpportunity> — every monitor implements this.
 *
 * The runner polls each registered source on its own cadence and pipes the
 * resulting opportunities into storage + the alert bus + the rules engine.
 *
 * - poll():       fetch raw data from the external system
 * - evaluate():   turn one raw item into a normalized Opportunity (or null)
 * - act():        optional automated action (place bid, exchange, trade)
 */

import type { Opportunity, ActionResult, SourceId } from './types.js';
import type { Storage } from './storage.js';
import type { AlertBus } from './alerts.js';

export interface SourceContext {
  storage: Storage;
  alerts: AlertBus;
  /** Per-source key/value scratchpad persisted in storage */
  state: Record<string, unknown>;
}

export interface Source<TItem = unknown> {
  id: SourceId;
  /** How often poll() should run in ms (the runner enforces this) */
  pollIntervalMs: number;
  poll(ctx: SourceContext): Promise<TItem[]>;
  evaluate(item: TItem, ctx: SourceContext): Opportunity | null;
  act?(opp: Opportunity, ctx: SourceContext): Promise<ActionResult>;
}
