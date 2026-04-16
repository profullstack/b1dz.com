/**
 * v2-pipeline daemon worker.
 *
 * Surfaces the shared process-wide v2 pipeline (observer + trade daemon)
 * to any user with a source_state row for source_id='v2-pipeline' and
 * payload.enabled=true. The pipeline itself runs at process scope — the
 * tick just snapshots its state into the caller's source_state so the
 * TUI can read it.
 *
 * Live execution activates only when V2_MODE=live *and* at least one
 * Executor has been registered via registerExecutor(). Until an executor
 * is wired, the daemon stays in observe or paper per V2_MODE and every
 * opportunity resolves without touching a wallet.
 */

import type { SourceWorker, UserContext } from '../types.js';
import { getB1dzVersion } from '@b1dz/core';
import { initV2Pipeline, v2Snapshot } from '../v2/pipeline.js';

export const v2PipelineWorker: SourceWorker = {
  id: 'v2-pipeline',
  pollIntervalMs: 5000,
  hasCredentials(payload) {
    return !!payload?.enabled;
  },
  async tick(ctx: UserContext) {
    await initV2Pipeline();
    const snap = v2Snapshot();
    if (!snap) {
      await ctx.savePayload({
        enabled: ctx.payload?.enabled ?? true,
        daemon: {
          lastTickAt: new Date().toISOString(),
          worker: 'v2-pipeline',
          status: 'warming',
          version: getB1dzVersion(),
        },
      });
      return;
    }

    await ctx.savePayload({
      enabled: ctx.payload?.enabled ?? true,
      v2: {
        mode: snap.mode,
        pairs: snap.pairs,
        adapters: snap.adapters,
        health: snap.health,
        recentOpportunities: snap.recentOpportunities,
        recentDecisions: snap.recentDecisions,
        circuit: snap.circuit,
        startedAt: new Date(snap.startedAt).toISOString(),
      },
      daemon: {
        lastTickAt: new Date().toISOString(),
        worker: 'v2-pipeline',
        status: snap.circuit.state === 'open' ? 'circuit-open' : 'running',
        version: getB1dzVersion(),
      },
    });
  },
};
