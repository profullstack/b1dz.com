import type { SourceWorker, UserContext } from '../types.js';
import { cryptoTradeSource, getTradeStatus, serializeTradeState } from '@b1dz/source-crypto-trade';
import { AlertBus, getB1dzVersion } from '@b1dz/core';
import { runnerStorageFor } from '../runner-storage.js';
import { logActivity, logRaw, getActivityLog, getRawLog } from './activity-log.js';

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
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      const text = args.map(String).join(' ');
      // Keep the main activity log high-signal only.
      if (text.startsWith('[') || text.includes('SIGNAL') || text.includes('EXECUTE') || text.includes('SOLD')) {
        if (
          text.includes('SIGNAL')
          || text.includes('EXECUTE')
          || text.includes('SOLD')
          || text.includes('FAILED')
          || text.includes('DAILY LOSS LIMIT')
        ) {
          logActivity(text, 'crypto-trade');
          return;
        }
      }
      logRaw(text, 'crypto-trade');
    };
    console.error = (...args: unknown[]) => {
      const text = args.map(String).join(' ');
      if (text.includes('FAILED') || text.includes('Unable to connect') || text.includes('lockout')) {
        logActivity(text, 'crypto-trade');
        return;
      }
      logRaw(text, 'crypto-trade');
    };

    try {
      const items = await cryptoTradeSource.poll(sourceCtx);
      const signals: unknown[] = (ctx.payload?.signals as unknown[]) ?? [];

      for (const item of items) {
        const opp = cryptoTradeSource.evaluate(item, sourceCtx);
        if (!opp) continue;
        signals.push(opp);
        logActivity(`⚡ SIGNAL: ${opp.title} confidence=${opp.confidence.toFixed(2)}`, 'crypto-trade');
        if (cryptoTradeSource.act) {
          const result = await cryptoTradeSource.act(opp, sourceCtx);
          if (result.ok) {
            logActivity(`✓ EXECUTED: ${result.message}`, 'crypto-trade');
          } else {
            logActivity(`✗ SKIPPED: ${result.message}`, 'crypto-trade');
          }
        }
      }

      while (signals.length > 100) signals.shift();

      // Get live status snapshot
      const status = getTradeStatus();

      await ctx.savePayload({
        enabled: ctx.payload?.enabled ?? true,
        signals,
        activityLog: getActivityLog('crypto-trade'),
        rawLog: getRawLog('crypto-trade'),
        tradeStatus: status,
        tradeState: serializeTradeState(),
        daemon: {
          lastTickAt: new Date().toISOString(),
          worker: 'crypto-trade',
          status: 'running',
          version: getB1dzVersion(),
        },
      });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  },
};
