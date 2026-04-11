import type { SourceWorker, UserContext } from '../types.js';
import { cryptoTradeSource, getTradeStatus, serializeTradeState } from '@b1dz/source-crypto-trade';
import { AlertBus } from '@b1dz/core';
import { runnerStorageFor } from '../runner-storage.js';
import { logActivity, getActivityLog } from './activity-log.js';

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

    // Capture ALL console.log from strategies into activity log
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      const text = args.map(String).join(' ');
      // Capture strategy/trade output into activity log (logActivity also prints)
      if (text.startsWith('[') || text.includes('SIGNAL') || text.includes('EXECUTE') || text.includes('SOLD')) {
        logActivity(text);
      } else {
        origLog.apply(console, args);
      }
    };

    try {
      const items = await cryptoTradeSource.poll(sourceCtx);
      const signals: unknown[] = (ctx.payload?.signals as unknown[]) ?? [];

      for (const item of items) {
        const opp = cryptoTradeSource.evaluate(item, sourceCtx);
        if (!opp) continue;
        signals.push(opp);
        logActivity(`⚡ SIGNAL: ${opp.title} confidence=${opp.confidence.toFixed(2)}`);
        if (cryptoTradeSource.act) {
          const result = await cryptoTradeSource.act(opp, sourceCtx);
          if (result.ok) {
            logActivity(`✓ EXECUTED: ${result.message}`);
          } else {
            logActivity(`✗ SKIPPED: ${result.message}`);
          }
        }
      }

      while (signals.length > 100) signals.shift();

      // Get live status snapshot
      const status = getTradeStatus();

      await ctx.savePayload({
        enabled: ctx.payload?.enabled ?? true,
        signals,
        activityLog: getActivityLog(),
        tradeStatus: status,
        tradeState: serializeTradeState(),
        daemon: {
          lastTickAt: new Date().toISOString(),
          worker: 'crypto-trade',
          status: 'running',
        },
      });
    } finally {
      console.log = origLog;
    }
  },
};
