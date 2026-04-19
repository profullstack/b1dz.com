import type { SourceWorker, UserContext } from '../types.js';
import {
  cryptoTradeSource,
  getTradeStatus,
  restoreAnalysisCache,
  serializeAnalysisCache,
  serializeTradeState,
  setTradingOverride,
  setDailyLossLimitPct,
  setDexExecutor,
} from '@b1dz/source-crypto-trade';
import { AlertBus, getAnalysisCache, getB1dzVersion, setAnalysisCache } from '@b1dz/core';
import { runnerStorageFor } from '../runner-storage.js';
import { logActivity, logRaw, getActivityLog, getRawLog } from './activity-log.js';
import { maybeBuildDexTradeExecutor } from '../executors/dex-trade-executor.js';

// Arm the DEX executor seam once per process. Returns null unless
// DEX_TRADE_EXECUTION=true + the wallet env is set — in which case the
// trade source logs DEX-BUY SKIPPED (signals still flow, execution
// doesn't). Fire-and-forget: if arming fails we keep running in the
// skip-only state so the TUI keeps showing DEX signals.
void maybeBuildDexTradeExecutor()
  .then((exec) => setDexExecutor(exec))
  .catch((e) => console.warn(`[trade] DEX executor boot failed: ${(e as Error).message}`));

// Analysis-cache persistence. Candle history + indicators are multi-MB;
// writing them into source_state.payload every 5s was blowing up Redis
// I/O and V8 churn. We now keep them in a dedicated Redis key, loaded
// once per worker process on first tick, then re-flushed every minute.
const ANALYSIS_CACHE_FLUSH_MS = 60_000;
const analysisCacheLoadedFor = new Set<string>();
let lastAnalysisCacheFlushAt = 0;

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
      // Bootstrap analysis state from the dedicated cache on first tick for
      // this user. Must happen BEFORE poll() so the source's own restore
      // path doesn't start from an empty map. Idempotent per (userId,
      // processLifetime).
      if (!analysisCacheLoadedFor.has(ctx.userId)) {
        analysisCacheLoadedFor.add(ctx.userId);
        try {
          const cached = await getAnalysisCache(ctx.userId, 'crypto-trade');
          if (cached) restoreAnalysisCache(cached);
        } catch (e) {
          logRaw(`[trade] analysis cache load failed: ${(e as Error).message}`, 'crypto-trade');
        }
      }

      // Resolve the trading override in priority order:
      //   1. UI toggle (crypto-ui-settings.tradingEnabled)  — user's explicit choice via TUI
      //   2. TRADING_ENABLED env flag                       — operator deploy-time setting
      //   3. Built-in default: true (ENABLED, override)
      // Only an explicit `false` at any layer halts entries. `null`
      // or missing values at a layer fall through to the next.
      const uiSettings = await storage.get<{ tradingEnabled?: boolean | null; dailyLossLimitPct?: number | null }>('source-state', 'crypto-ui-settings');
      const uiOverride = uiSettings?.tradingEnabled;
      const envRaw = (process.env.TRADING_ENABLED ?? '').trim().toLowerCase();
      const envOverride = envRaw === 'true' ? true : envRaw === 'false' ? false : null;
      const resolved = uiOverride === true || uiOverride === false
        ? uiOverride
        : envOverride === true || envOverride === false
          ? envOverride
          : true;
      setTradingOverride(resolved);
      setDailyLossLimitPct(
        typeof uiSettings?.dailyLossLimitPct === 'number' && Number.isFinite(uiSettings.dailyLossLimitPct) && uiSettings.dailyLossLimitPct > 0
          ? uiSettings.dailyLossLimitPct
          : null,
      );

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

      // Flush analysis cache on a slow cadence — the whole point of the
      // split is to NOT do this every tick.
      const now = Date.now();
      if (now - lastAnalysisCacheFlushAt >= ANALYSIS_CACHE_FLUSH_MS) {
        lastAnalysisCacheFlushAt = now;
        try {
          await setAnalysisCache(ctx.userId, 'crypto-trade', serializeAnalysisCache());
        } catch (e) {
          logRaw(`[trade] analysis cache flush failed: ${(e as Error).message}`, 'crypto-trade');
        }
      }
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  },
};
