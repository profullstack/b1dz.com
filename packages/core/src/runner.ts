/**
 * Runner — multiplexes a set of Sources, polling each on its own interval.
 *
 * Drives the whole pipeline:
 *   1. poll() the source
 *   2. evaluate() each item into an Opportunity (or skip)
 *   3. persist opportunities and emit alerts on state transitions
 *
 * The CLI and the Next.js app both use this. Run it long-lived (CLI/daemon)
 * or one-shot (cron/serverless API route).
 */

import type { Source, SourceContext } from './source.js';
import type { Storage } from './storage.js';
import type { AlertBus } from './alerts.js';
import { COLLECTIONS } from './storage.js';
import type { Opportunity, SourceState } from './types.js';

export interface RunnerOptions {
  sources: Source[];
  storage: Storage;
  alerts: AlertBus;
}

export class Runner {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private contexts = new Map<string, SourceContext>();
  constructor(private opts: RunnerOptions) {}

  async start() {
    for (const src of this.opts.sources) {
      const stored = await this.opts.storage.get<SourceState>(COLLECTIONS.sourceState, src.id);
      this.contexts.set(src.id, {
        storage: this.opts.storage,
        alerts: this.opts.alerts,
        state: stored?.data ?? {},
      });
      // First tick immediately, then on interval
      void this.tick(src);
      this.timers.set(src.id, setInterval(() => void this.tick(src), src.pollIntervalMs));
    }
  }

  async stop() {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  async tick(src: Source) {
    const ctx = this.contexts.get(src.id)!;
    try {
      const items = await src.poll(ctx);
      for (const item of items) {
        const opp = src.evaluate(item, ctx);
        if (!opp) continue;
        await this.opts.storage.put<Opportunity>(COLLECTIONS.opportunities, opp.id, opp);
      }
      await this.opts.storage.put<SourceState>(COLLECTIONS.sourceState, src.id, {
        sourceId: src.id,
        lastPolledAt: Date.now(),
        data: ctx.state,
      });
    } catch (e) {
      this.opts.alerts.push({
        level: 'bad',
        sourceId: src.id,
        text: `tick error: ${(e as Error).message}`,
      });
    }
  }
}
