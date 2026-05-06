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

// DEX executor is armed lazily inside applyEnvOverlay so that the
// user's SOLANA_PRIVATE_KEY / EVM_PRIVATE_KEY / BASE_RPC_URL /
// SOLANA_RPC_URL from user_settings are visible on process.env before
// we read them. Module-level arming would run before any overlay and
// always see empty keys.
//
// The previous implementation flipped a single `dexExecutorArmed` flag
// to true at the start of the first attempt — so a missing env var on
// boot meant the executor never came up even after the user fixed
// their settings (until daemon restart). Now we retry on every tick
// until either an executor is built (success) OR the user-config
// overlay is stable AND has none of the required env vars (no point
// retrying — log once and stop). Operators who later fill in BASE_RPC_URL
// in the web UI see the leg arm on the next tick without restart.
let dexExecutorAttemptInFlight = false;
let dexExecutorArmedAt: number | null = null;
let dexExecutorLastAttemptLogAt = 0;
const DEX_EXECUTOR_RETRY_LOG_INTERVAL_MS = 5 * 60_000;

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

      // Arm the DEX executor lazily, inside applyEnvOverlay, so the
      // user's keys + RPC URLs are visible on process.env. We retry
      // every tick until success — operators frequently add an RPC URL
      // after first boot and we want the next tick to pick it up
      // without forcing a daemon restart.
      if (dexExecutorArmedAt === null && !dexExecutorAttemptInFlight) {
        dexExecutorAttemptInFlight = true;
        maybeBuildDexTradeExecutor()
          .then((exec) => {
            if (exec) {
              setDexExecutor(exec);
              dexExecutorArmedAt = Date.now();
              logActivity('[trade] DEX executor armed', 'crypto-trade');
            } else {
              // No leg armed — likely missing BASE_RPC_URL +/or
              // SOLANA_RPC_URL +/or wallet keys. Throttle the log so
              // we don't spam every tick. The next tick still retries.
              const now = Date.now();
              if (now - dexExecutorLastAttemptLogAt >= DEX_EXECUTOR_RETRY_LOG_INTERVAL_MS) {
                dexExecutorLastAttemptLogAt = now;
                logRaw(
                  '[trade] DEX executor not armed (missing EVM_PRIVATE_KEY+BASE_RPC_URL or '
                  + 'SOLANA_PRIVATE_KEY+SOLANA_RPC_URL) — will retry next tick',
                  'crypto-trade',
                );
              }
            }
          })
          .catch((e) => logRaw(`[trade] DEX executor boot failed: ${(e as Error).message}`, 'crypto-trade'))
          .finally(() => { dexExecutorAttemptInFlight = false; });
      }

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
