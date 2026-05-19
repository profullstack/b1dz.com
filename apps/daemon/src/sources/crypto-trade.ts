import type { SourceWorker, UserContext } from '../types.js';
import {
  cryptoTradeSource,
  getTradeStatus,
  getLastPollPhaseTimings,
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

// Railway-level panic kill switch, captured at module-load time. The
// per-tick applyEnvOverlay() copies user_settings.TRADING_ENABLED on top
// of process.env, which would otherwise let a stale "true" in a user's
// settings catalog mask the Railway env. Reading process.env exactly
// once, before any tick runs, isolates this flag from the overlay.
const TRADING_ENV_PANIC_HALT = (() => {
  const raw = (process.env.TRADING_ENABLED ?? '').trim().toLowerCase();
  return raw === 'false';
})();

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

      // Resolve the trading override. Priority:
      //   1. TRADING_ENV_PANIC_HALT (Railway env = false at module load)  → halt
      //   2. UI tradingEnabled=false (crypto-ui-settings)                 → halt
      //   3. UI tradingEnabled=true                                       → enabled
      //   4. env TRADING_ENABLED=true (post-overlay)                      → enabled
      //   5. default                                                      → enabled
      // (1) bypasses the per-tick user-config overlay, so a stale "true"
      // in user_settings.TRADING_ENABLED cannot mask the Railway panic
      // switch. (2)–(4) fall back to normal toggle behavior.
      const uiSettings = await storage.get<{ tradingEnabled?: boolean | null; dailyLossLimitPct?: number | null }>('source-state', 'crypto-ui-settings');
      const uiOverride = uiSettings?.tradingEnabled;
      const envRaw = (process.env.TRADING_ENABLED ?? '').trim().toLowerCase();
      const envOverride = envRaw === 'true' ? true : envRaw === 'false' ? false : null;
      const resolved = TRADING_ENV_PANIC_HALT
        ? false
        : uiOverride === false
          ? false
          : uiOverride === true
            ? true
            : envOverride === false
              ? false
              : envOverride === true
                ? true
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

      // Per-phase tick latency tracking. The TUI's 30s "stale" threshold
      // is unforgiving — when ops sees `stale 52s` we want to know which
      // phase ran long without grepping every log line. Threshold-gated
      // so quiet ticks don't spam.
      const tickStart = Date.now();
      const items = await cryptoTradeSource.poll(sourceCtx);
      const pollMs = Date.now() - tickStart;
      const evalStart = Date.now();
      const signals: unknown[] = (ctx.payload?.signals as unknown[]) ?? [];

      let signalCount = 0;
      let executedCount = 0;
      for (const item of items) {
        const opp = cryptoTradeSource.evaluate(item, sourceCtx);
        if (!opp) continue;
        signals.push(opp);
        signalCount += 1;
        logActivity(`⚡ SIGNAL: ${opp.title} confidence=${opp.confidence.toFixed(2)}`, 'crypto-trade');
        if (cryptoTradeSource.act) {
          const result = await cryptoTradeSource.act(opp, sourceCtx);
          if (result.ok) {
            executedCount += 1;
            logActivity(`✓ EXECUTED: ${result.message}`, 'crypto-trade');
          } else {
            logActivity(`✗ SKIPPED: ${result.message}`, 'crypto-trade');
          }
        }
      }
      const evalMs = Date.now() - evalStart;
      const tickTotalMs = Date.now() - tickStart;

      // One line per slow tick → searchable as `[trade] tick latency`.
      // Threshold = pollIntervalMs × 4 (= 20s for the default 5s tick)
      // so we only print when something's notably off, not on the happy
      // path. Includes the per-phase breakdown from
      // getLastPollPhaseTimings() so ops can pinpoint the culprit
      // without grepping (cold-start hydration, balance refresh,
      // per-pair scan, market-mins refresh) instead of guessing.
      const slowTickThresholdMs = cryptoTradeWorker.pollIntervalMs * 4;
      if (tickTotalMs >= slowTickThresholdMs || tickTotalMs >= 30_000) {
        const phases = getLastPollPhaseTimings();
        const phaseStr = phases
          ? ` hydrate=${phases.hydrateMs}ms balances=${phases.balancesMs}ms `
            + `discover=${phases.discoverMs}ms scan=${phases.scanMs}ms `
            + `marketMins=${phases.marketMinsMs}ms pairs=${phases.pairs}`
          : '';
        logRaw(
          `[trade] tick latency total=${tickTotalMs}ms poll=${pollMs}ms `
          + `evaluate+act=${evalMs}ms items=${items.length} `
          + `signals=${signalCount} executed=${executedCount}${phaseStr}`,
          'crypto-trade',
        );
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
