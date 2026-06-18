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
  setSpendBudget,
  setMaxPositionUsd,
  syncSpendLedger,
  drainSpendLedger,
  isBudgetWindow,
  windowStartFor,
  setAiSizeMultiplier,
  executeAgentMarketBuy,
  type BudgetWindow,
} from '@b1dz/source-crypto-trade';
import { analyze, aiSizeMultiplier, RateLimiter, type AiAnalysis } from '@b1dz/ai-analyzer';
import { loadUserConfig } from '../user-config.js';
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

/** userId → windowStart the spend ledger was last seeded for (re-seed on rollover). */
const spendLedgerSeededFor = new Map<string, number>();

/**
 * Keep the engine's in-memory spend budget in sync with the durable
 * `crypto_spend_ledger` table:
 *   1. Once per (user, window) — sum this window's spend from the DB and seed
 *      the engine, so the budget survives daemon restarts.
 *   2. Every tick — drain buys the engine just recorded and persist them.
 * Best-effort: ledger failures never block trading (the in-memory counter is
 * still authoritative for the live process).
 */
async function reconcileSpendLedger(
  ctx: UserContext,
  _storage: unknown,
  window: BudgetWindow,
): Promise<void> {
  const windowStart = windowStartFor(window, Date.now());
  try {
    if (spendLedgerSeededFor.get(ctx.userId) !== windowStart) {
      const { data, error } = await ctx.supabase
        .from('crypto_spend_ledger')
        .select('usd')
        .eq('user_id', ctx.userId)
        .gte('ts', new Date(windowStart).toISOString());
      if (!error) {
        const sum = (data ?? []).reduce((acc: number, r: { usd: number | string }) => acc + Number(r.usd ?? 0), 0);
        syncSpendLedger(sum);
        spendLedgerSeededFor.set(ctx.userId, windowStart);
      }
    }
  } catch (e) {
    logRaw(`[trade] spend-ledger seed failed: ${(e as Error).message}`, 'crypto-trade');
  }

  const entries = drainSpendLedger();
  if (entries.length === 0) return;
  try {
    await ctx.supabase.from('crypto_spend_ledger').insert(
      entries.map((e) => ({
        user_id: ctx.userId,
        ts: new Date(e.ts).toISOString(),
        usd: e.usd,
        exchange: e.exchange,
        pair: e.pair,
        source: e.source,
        agent_token_id: e.tokenId ?? null,
      })),
    );
  } catch (e) {
    logRaw(`[trade] spend-ledger write failed: ${(e as Error).message}`, 'crypto-trade');
  }
}

/** Per-user AI-analyzer rate limiters + last-run timestamps. */
const aiRateLimiters = new Map<string, RateLimiter>();
const aiLastRunAt = new Map<string, number>();
const AI_MIN_INTERVAL_MS = 30_000; // never analyze more often than this, regardless of maxPerMin

/**
 * AI analyzer step (Phase 2 — "Coinbase Advisor" analog). When the user has
 * enabled it AND set their own provider key, call OUT to their model to score
 * the active market and set the engine's AI size multiplier. The multiplier
 * only scales a buy the deterministic strategy already wants and is itself
 * clamped + bounded by the spend budget. Best-effort: any failure resets the
 * multiplier to neutral (1×) so a flaky key never blocks or distorts trading.
 */
async function reconcileAiAnalyzer(ctx: UserContext): Promise<void> {
  let analysis: AiAnalysis | null = null;
  try {
    const cfg = await loadUserConfig(ctx.userId);
    const enabled = (cfg.getUserPlain('AI_ANALYZER_ENABLED') ?? '').toLowerCase() === 'true';
    if (!enabled) {
      setAiSizeMultiplier(1);
      return;
    }
    const provider = cfg.getUserPlain('AI_PROVIDER') === 'openai' ? 'openai' : 'anthropic';
    // STRICT per-user key — never operator env (env-fallback incident).
    const apiKey = provider === 'openai' ? cfg.getUserSecret('OPENAI_API_KEY') : cfg.getUserSecret('ANTHROPIC_API_KEY');
    if (!apiKey) {
      setAiSizeMultiplier(1);
      return;
    }

    const now = Date.now();
    if (now - (aiLastRunAt.get(ctx.userId) ?? 0) < AI_MIN_INTERVAL_MS) return; // keep last multiplier
    const maxPerMin = Number(cfg.getUserPlain('AI_MAX_CALLS_PER_MIN') ?? '6');
    let rl = aiRateLimiters.get(ctx.userId);
    if (!rl) { rl = new RateLimiter(Number.isFinite(maxPerMin) && maxPerMin > 0 ? maxPerMin : 6); aiRateLimiters.set(ctx.userId, rl); }
    if (!rl.allow(now)) return;
    aiLastRunAt.set(ctx.userId, now);

    // Use the active position with the most price history as the market read.
    const status = getTradeStatus();
    const positions = status.positions ?? [];
    const target = positions
      .filter((p) => (p.priceSamples?.length ?? 0) >= 3)
      .sort((a, b) => (b.priceSamples?.length ?? 0) - (a.priceSamples?.length ?? 0))[0];
    if (!target) {
      setAiSizeMultiplier(1); // flat / not enough data → neutral
      return;
    }

    analysis = await analyze(
      {
        pair: target.pair,
        exchange: target.exchange,
        lastPrice: target.currentPrice,
        closes: target.priceSamples.slice(-20),
        deterministicSignal: null,
      },
      { provider, apiKey, model: cfg.getUserPlain('AI_MODEL') || undefined },
    );
    setAiSizeMultiplier(aiSizeMultiplier(analysis, Date.now()));
  } catch (e) {
    setAiSizeMultiplier(1); // fail safe to neutral
    logRaw(`[trade] AI analyzer skipped: ${(e as Error).message}`, 'crypto-trade');
    return;
  }

  // Persist the latest analysis for the dashboard/TUI (best-effort).
  if (analysis) {
    try {
      await ctx.supabase.from('source_state').upsert(
        { user_id: ctx.userId, source_id: 'ai-analysis', payload: analysis as unknown as Record<string, unknown>, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,source_id' },
      );
    } catch { /* non-fatal */ }
  }
}

interface AgentQueueItem {
  idempotencyKey: string;
  tokenId: string;
  pair: string;
  exchange: string | null;
  usd: number;
  side: 'buy';
  enqueuedAt: string;
}

/**
 * Drain the agent-orders queue (Phase 3 — "Coinbase for Agents"). Orders are
 * authorized + per-token-budgeted by the web API, then enqueued in source_state
 * 'agent-orders'; here we execute each BUY through the engine, which re-applies
 * the global spend budget + records the spend tagged source='agent' with the
 * token id (so per-token budgets reconcile). Processed items are removed and
 * the outcome written to agent_actions.
 */
async function reconcileAgentOrders(ctx: UserContext): Promise<void> {
  let queue: AgentQueueItem[];
  try {
    const { data } = await ctx.supabase
      .from('source_state')
      .select('payload')
      .eq('user_id', ctx.userId)
      .eq('source_id', 'agent-orders')
      .maybeSingle();
    queue = ((data?.payload as { queue?: AgentQueueItem[] } | undefined)?.queue ?? []) as AgentQueueItem[];
  } catch {
    return;
  }
  if (queue.length === 0) return;

  for (const item of queue) {
    let ok = false;
    let message = 'skipped';
    try {
      const res = await executeAgentMarketBuy({ pair: item.pair, exchange: item.exchange ?? undefined, usd: item.usd, tokenId: item.tokenId });
      ok = res.ok;
      message = res.message;
    } catch (e) {
      message = (e as Error).message;
    }
    try {
      await ctx.supabase.from('agent_actions').insert({
        user_id: ctx.userId,
        agent_token_id: item.tokenId,
        action: 'execute_order',
        detail: { pair: item.pair, usd: item.usd, idempotencyKey: item.idempotencyKey, message },
        ok,
      });
    } catch { /* non-fatal */ }
  }

  // Remove only the keys we processed — re-read so orders enqueued mid-tick
  // survive instead of being clobbered.
  const processed = new Set(queue.map((q) => q.idempotencyKey));
  try {
    const { data } = await ctx.supabase
      .from('source_state')
      .select('payload')
      .eq('user_id', ctx.userId)
      .eq('source_id', 'agent-orders')
      .maybeSingle();
    const current = ((data?.payload as { queue?: AgentQueueItem[] } | undefined)?.queue ?? []) as AgentQueueItem[];
    const remaining = current.filter((q) => !processed.has(q.idempotencyKey));
    await ctx.supabase.from('source_state').upsert(
      { user_id: ctx.userId, source_id: 'agent-orders', payload: { queue: remaining }, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,source_id' },
    );
  } catch { /* non-fatal */ }
}

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
      const uiSettings = await storage.get<{
        tradingEnabled?: boolean | null;
        dailyLossLimitPct?: number | null;
        spendBudgetUsd?: number | null;
        budgetWindow?: string | null;
        maxPositionUsd?: number | null;
      }>('source-state', 'crypto-ui-settings');
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

      // Crypto spend budget — the rolling USD cap on buys (engine/AI/agent).
      // Per-user, flows via crypto-ui-settings (NOT operator env), same channel
      // as the daily loss limit above.
      const budgetWindow: BudgetWindow = isBudgetWindow(uiSettings?.budgetWindow) ? uiSettings.budgetWindow : 'daily';
      setSpendBudget(
        typeof uiSettings?.spendBudgetUsd === 'number' && Number.isFinite(uiSettings.spendBudgetUsd) && uiSettings.spendBudgetUsd > 0
          ? uiSettings.spendBudgetUsd
          : null,
        budgetWindow,
      );
      setMaxPositionUsd(
        typeof uiSettings?.maxPositionUsd === 'number' && Number.isFinite(uiSettings.maxPositionUsd) && uiSettings.maxPositionUsd > 0
          ? uiSettings.maxPositionUsd
          : null,
      );

      // Seed the in-memory spent counter from the durable ledger once per user
      // (so the budget survives daemon restarts). Then drain freshly-recorded
      // buys into the ledger each tick.
      await reconcileSpendLedger(ctx, storage, budgetWindow);
      await reconcileAiAnalyzer(ctx);
      await reconcileAgentOrders(ctx);

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
