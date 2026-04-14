/**
 * POST /api/backtest
 *
 * Runs the deterministic analysis engine against historical candles and
 * returns per-pair + aggregate metrics. Read-only — never executes trades.
 *
 * Uses the multi-pair simulator so exchange-level position limits are
 * enforced: only one open position per exchange at a time (matching the
 * live daemon). Results are persisted to backtest_runs + backtest_trades
 * tables so runs can be compared over time.
 *
 * Body: {
 *   timeframe: '1m'|'5m'|'15m'|'1h'|'4h'|'1d'|'1w',
 *   pairs?: string[],          // defaults to getActivePairs()
 *   exchange?: string,         // kraken | binance-us | coinbase | all
 *   limit?: number,            // candles per pair, 50..1000 (default 500)
 *   equity?: number,           // starting equity USD per exchange (default 100)
 *   feeRate?: number,
 *   slippagePct?: number,
 *   spreadPct?: number,
 * }
 */
import type { NextRequest } from 'next/server';
import {
  fetchHistoricalCandles,
  runMultiPairBacktest,
  type AnalysisTimeframe,
  type BacktestMultiResult,
  type BacktestTrade,
  type Candle,
} from '@b1dz/source-crypto-trade';
import { getActivePairs } from '@b1dz/source-crypto-arb';
import { authenticate, unauthorized, type AuthedRequest } from '@/lib/api-auth';

const TIMEFRAMES: readonly AnalysisTimeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const EXCHANGE_LIST = ['kraken', 'binance-us', 'coinbase'] as const;
const EXCHANGES = new Set<string>(EXCHANGE_LIST);

export const maxDuration = 300;

interface BacktestRequest {
  timeframe?: string;
  pairs?: string[];
  exchange?: string;
  limit?: number;
  equity?: number;
  feeRate?: number;
  slippagePct?: number;
  spreadPct?: number;
}

interface PerPairEntry {
  pair: string;
  exchange: string;
  candles: number;
  trades: number;
  netPnl: number;
  error: string | null;
  signalsSkippedForOpenPosition?: number;
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as BacktestRequest;
  const timeframe = (body.timeframe ?? '5m') as AnalysisTimeframe;
  if (!TIMEFRAMES.includes(timeframe)) {
    return Response.json({ error: `invalid timeframe "${timeframe}"`, validTimeframes: TIMEFRAMES }, { status: 400 });
  }
  const rawExchange = (body.exchange ?? 'kraken').toLowerCase();
  const exchangesToRun: string[] = rawExchange === 'all' ? [...EXCHANGE_LIST] : [rawExchange];
  for (const ex of exchangesToRun) {
    if (!EXCHANGES.has(ex)) {
      return Response.json({ error: `invalid exchange "${ex}"`, validExchanges: ['all', ...EXCHANGE_LIST] }, { status: 400 });
    }
  }
  const limit = Math.max(50, Math.min(1000, Number(body.limit ?? 500)));
  const equity = Math.max(1, Number(body.equity ?? 100));
  const feeRate = Number.isFinite(Number(body.feeRate)) ? Math.max(0, Math.min(0.05, Number(body.feeRate))) : undefined;
  const slippagePct = Number.isFinite(Number(body.slippagePct)) ? Math.max(0, Math.min(5, Number(body.slippagePct))) : undefined;
  const spreadPct = Number.isFinite(Number(body.spreadPct)) ? Math.max(0, Math.min(5, Number(body.spreadPct))) : undefined;

  const pairs = Array.isArray(body.pairs) && body.pairs.length > 0
    ? body.pairs.map(String).filter(Boolean)
    : await getActivePairs();

  if (pairs.length === 0) {
    return Response.json({ error: 'no pairs available — pass pairs in body or wait for discovery' }, { status: 400 });
  }

  const startedAt = Date.now();
  console.log(`[api/backtest] user=${auth.userId.slice(0, 8)} tf=${timeframe} exchange=${exchangesToRun.join(',')} pairs=${pairs.length} limit=${limit}`);

  const aggregateTrades: BacktestTrade[] = [];
  const perPair: PerPairEntry[] = [];
  const perExchange: Record<string, { trades: number; netPnl: number; grossPnl: number; fees: number; succeeded: number; skipped: number; failed: number; signalsSkipped: number; haltedByDailyLossLimit: boolean }> = {};
  let totalCandles = 0;
  let totalSignalsSkipped = 0;
  let anyHalted = false;

  for (const ex of exchangesToRun) {
    perExchange[ex] = { trades: 0, netPnl: 0, grossPnl: 0, fees: 0, succeeded: 0, skipped: 0, failed: 0, signalsSkipped: 0, haltedByDailyLossLimit: false };

    // Fetch candles for every pair on this exchange; collect the ones that
    // come back with enough data to be usable.
    const usablePairs: { symbol: string; candles: Candle[] }[] = [];
    for (const pair of pairs) {
      try {
        const candles = await fetchHistoricalCandles(ex, pair, timeframe, limit);
        if (candles.length < 50) {
          perPair.push({ pair, exchange: ex, candles: candles.length, trades: 0, netPnl: 0, error: 'insufficient candles' });
          perExchange[ex].skipped++;
          continue;
        }
        usablePairs.push({ symbol: pair, candles });
        totalCandles += candles.length;
      } catch (e) {
        perPair.push({ pair, exchange: ex, candles: 0, trades: 0, netPnl: 0, error: (e as Error).message.slice(0, 160) });
        perExchange[ex].failed++;
      }
    }

    if (usablePairs.length === 0) continue;

    // Single multi-pair simulation for this exchange: one position at a
    // time, shared daily-loss halt, per-pair cooldown.
    const assumptions: Record<string, number> = { startingEquityUsd: equity };
    if (feeRate !== undefined) assumptions.feeRate = feeRate;
    if (slippagePct !== undefined) assumptions.slippagePct = slippagePct;
    if (spreadPct !== undefined) assumptions.spreadPct = spreadPct;

    let result: BacktestMultiResult;
    try {
      result = runMultiPairBacktest({
        exchange: ex,
        pairs: usablePairs,
        assumptions,
      });
    } catch (e) {
      console.error(`[api/backtest] runMultiPairBacktest failed on ${ex}: ${(e as Error).message}`);
      continue;
    }

    aggregateTrades.push(...result.trades);
    totalSignalsSkipped += result.signalsSkippedForOpenPosition;
    if (result.haltedByDailyLossLimit) anyHalted = true;
    perExchange[ex].haltedByDailyLossLimit = result.haltedByDailyLossLimit;
    perExchange[ex].signalsSkipped = result.signalsSkippedForOpenPosition;

    for (const { symbol, candles } of usablePairs) {
      const pairStats = result.perPair[symbol] ?? { trades: 0, netPnl: 0, candles: candles.length };
      perPair.push({
        pair: symbol,
        exchange: ex,
        candles: candles.length,
        trades: pairStats.trades,
        netPnl: pairStats.netPnl,
        error: null,
      });
      perExchange[ex].succeeded++;
    }

    perExchange[ex].trades += result.trades.length;
    perExchange[ex].netPnl += result.trades.reduce((sum, t) => sum + t.netPnl, 0);
    perExchange[ex].grossPnl += result.trades.reduce((sum, t) => sum + t.grossPnl, 0);
    perExchange[ex].fees += result.trades.reduce((sum, t) => sum + t.fees, 0);
  }

  // ----- Build response payload -----
  const totalNetPnl = aggregateTrades.reduce((sum, t) => sum + t.netPnl, 0);
  const totalGrossPnl = aggregateTrades.reduce((sum, t) => sum + t.grossPnl, 0);
  const totalFees = aggregateTrades.reduce((sum, t) => sum + t.fees, 0);
  const winningTrades = aggregateTrades.filter((t) => t.netPnl >= 0).length;
  const losingTrades = aggregateTrades.filter((t) => t.netPnl < 0).length;
  const winningPairs = perPair.filter((p) => p.trades > 0 && p.netPnl > 0).length;
  const losingPairs = perPair.filter((p) => p.trades > 0 && p.netPnl < 0).length;
  const succeededPairs = perPair.filter((p) => !p.error).length;
  const skippedPairs = perPair.filter((p) => p.error === 'insufficient candles').length;
  const failedPairs = perPair.filter((p) => p.error && p.error !== 'insufficient candles').length;

  // Per-exchange capital (one $100 bucket per exchange, not per pair —
  // matches how live equity is pooled per exchange).
  const totalCapitalUsd = equity * exchangesToRun.length;
  const { computeBacktestMetrics } = await import('@b1dz/source-crypto-trade');
  const aggregateMetrics = computeBacktestMetrics(aggregateTrades, Math.max(1, totalCapitalUsd));
  const durationMs = Date.now() - startedAt;
  console.log(`[api/backtest] done user=${auth.userId.slice(0, 8)} ok=${succeededPairs} skip=${skippedPairs} fail=${failedPairs} trades=${aggregateTrades.length} skippedForOpenPos=${totalSignalsSkipped} net=$${totalNetPnl.toFixed(2)} duration=${durationMs}ms`);

  // ----- Persist to DB -----
  let runId: string | null = null;
  try {
    runId = await persistBacktestRun(auth, {
      timeframe,
      exchange: rawExchange,
      exchangesRan: exchangesToRun,
      pairsRequested: pairs.length * exchangesToRun.length,
      limit,
      equity,
      feeRate,
      slippagePct,
      spreadPct,
      totalCandles,
      totalTrades: aggregateTrades.length,
      totalNetPnl,
      totalGrossPnl,
      totalFees,
      winningTrades,
      losingTrades,
      winningPairs,
      losingPairs,
      totalCapitalUsd,
      haltedByDailyLossLimit: anyHalted,
      durationMs,
      metrics: aggregateMetrics,
      perExchange,
      trades: aggregateTrades,
    });
  } catch (e) {
    console.error(`[api/backtest] persist failed: ${(e as Error).message}`);
  }

  return Response.json({
    runId,
    timeframe,
    exchange: rawExchange,
    exchangesRan: exchangesToRun,
    limit,
    equity,
    pairs: perPair,
    perExchange,
    aggregate: {
      trades: aggregateTrades.length,
      candles: totalCandles,
      metrics: aggregateMetrics,
      totalNetPnl,
      totalGrossPnl,
      totalFees,
      winningTrades,
      losingTrades,
      totalCapitalUsd,
      winningPairs,
      losingPairs,
      signalsSkippedForOpenPosition: totalSignalsSkipped,
      haltedByDailyLossLimit: anyHalted,
    },
    summary: {
      succeeded: succeededPairs,
      skipped: skippedPairs,
      failed: failedPairs,
      pairsRequested: pairs.length * exchangesToRun.length,
      durationMs,
    },
  });
}

// ─── Persistence ──────────────────────────────────────────────

interface PersistArgs {
  timeframe: string;
  exchange: string;
  exchangesRan: string[];
  pairsRequested: number;
  limit: number;
  equity: number;
  feeRate?: number;
  slippagePct?: number;
  spreadPct?: number;
  totalCandles: number;
  totalTrades: number;
  totalNetPnl: number;
  totalGrossPnl: number;
  totalFees: number;
  winningTrades: number;
  losingTrades: number;
  winningPairs: number;
  losingPairs: number;
  totalCapitalUsd: number;
  haltedByDailyLossLimit: boolean;
  durationMs: number;
  metrics: unknown;
  perExchange: Record<string, unknown>;
  trades: BacktestTrade[];
}

async function persistBacktestRun(auth: AuthedRequest, args: PersistArgs): Promise<string | null> {
  const runRow = {
    user_id: auth.userId,
    timeframe: args.timeframe,
    exchange: args.exchange,
    exchanges_ran: args.exchangesRan,
    pairs_requested: args.pairsRequested,
    limit_candles: args.limit,
    equity: args.equity,
    fee_rate: args.feeRate ?? null,
    slippage_pct: args.slippagePct ?? null,
    spread_pct: args.spreadPct ?? null,
    total_candles: args.totalCandles,
    total_trades: args.totalTrades,
    total_net_pnl: args.totalNetPnl,
    total_gross_pnl: args.totalGrossPnl,
    total_fees: args.totalFees,
    winning_trades: args.winningTrades,
    losing_trades: args.losingTrades,
    winning_pairs: args.winningPairs,
    losing_pairs: args.losingPairs,
    total_capital_usd: args.totalCapitalUsd,
    halted_by_daily_loss_limit: args.haltedByDailyLossLimit,
    duration_ms: args.durationMs,
    metrics: args.metrics as object,
    per_exchange: args.perExchange as object,
  };

  const { data: runData, error: runErr } = await auth.client
    .from('backtest_runs')
    .insert(runRow)
    .select('id')
    .single();
  if (runErr || !runData) {
    throw new Error(`backtest_runs insert failed: ${runErr?.message ?? 'no row returned'}`);
  }
  const runId = runData.id as string;

  if (args.trades.length > 0) {
    const tradeRows = args.trades.map((t) => ({
      run_id: runId,
      user_id: auth.userId,
      symbol: t.symbol,
      exchange: t.exchange,
      direction: t.direction,
      regime: t.regime,
      setup_type: t.setupType,
      score: t.score,
      entry_time: new Date(t.entryTime).toISOString(),
      exit_time: new Date(t.exitTime).toISOString(),
      entry_price: t.entryPrice,
      exit_price: t.exitPrice,
      stop_loss: t.stopLoss,
      take_profit: t.takeProfit,
      gross_pnl: t.grossPnl,
      fees: t.fees,
      slippage_cost: t.slippageCost,
      net_pnl: t.netPnl,
      hold_minutes: t.holdMinutes,
      hour_of_day: t.hourOfDay,
      volatility_bucket: t.volatilityBucket,
    }));
    // Chunk inserts to keep each request well under typical row limits.
    const CHUNK = 500;
    for (let i = 0; i < tradeRows.length; i += CHUNK) {
      const slice = tradeRows.slice(i, i + CHUNK);
      const { error: tradeErr } = await auth.client.from('backtest_trades').insert(slice);
      if (tradeErr) throw new Error(`backtest_trades insert failed: ${tradeErr.message}`);
    }
  }
  return runId;
}
