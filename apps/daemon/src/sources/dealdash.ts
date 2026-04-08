/**
 * DealDash worker stub.
 *
 * Right now this just writes a heartbeat into source_state.payload.daemon
 * so we can prove the scheduler is firing per-user. The real polling logic
 * (currently inside the lifted TUI's tick() function) gets ported here in
 * Phase 3 of the refactor — see docs/refactor-plan.md.
 */

import type { SourceWorker } from '../types.js';

export const dealdashWorker: SourceWorker = {
  id: 'dealdash',
  pollIntervalMs: 5000,
  hasCredentials(payload) {
    const c = (payload?.credentials as { phpsessid?: string; rememberme?: string } | undefined);
    return !!(c?.phpsessid && c?.rememberme);
  },
  async tick(ctx) {
    // TODO Phase 3: lift the TUI's tick() into a poll() function in
    // packages/source-dealdash/src/poll.ts that takes ctx and writes
    // opportunities + alerts via ctx.supabase. For now just heartbeat so
    // we can verify the scheduler is firing per user.
    await ctx.savePayload({
      daemon: {
        lastTickAt: new Date().toISOString(),
        worker: 'dealdash',
        status: 'stub',
      },
    });
  },
};
