import type { SourceWorker, UserContext } from '../types.js';
import { cryptoTradeSource } from '@b1dz/source-crypto-trade';
import { AlertBus } from '@b1dz/core';
import { runnerStorageFor } from '../runner-storage.js';

export const cryptoTradeWorker: SourceWorker = {
  id: 'crypto-trade',
  pollIntervalMs: 5000,
  hasCredentials(payload) {
    return !!(payload?.enabled);
  },
  async tick(ctx: UserContext) {
    const storage = runnerStorageFor(ctx);
    const alerts = new AlertBus();
    const sourceCtx = { storage, alerts, state: ctx.payload };

    const items = await cryptoTradeSource.poll(sourceCtx);
    const signals: unknown[] = (ctx.payload?.signals as unknown[]) ?? [];

    for (const item of items) {
      const opp = cryptoTradeSource.evaluate(item, sourceCtx);
      if (!opp) continue;
      signals.push(opp);
      console.log(`b1dzd: trade signal ${opp.title} confidence=${opp.confidence}`);
      if (cryptoTradeSource.act) {
        const result = await cryptoTradeSource.act(opp, sourceCtx);
        if (result.ok) console.log(`b1dzd: trade executed: ${result.message}`);
      }
    }

    while (signals.length > 100) signals.shift();

    await ctx.savePayload({
      signals,
      daemon: {
        lastTickAt: new Date().toISOString(),
        worker: 'crypto-trade',
        status: 'running',
      },
    });
  },
};
