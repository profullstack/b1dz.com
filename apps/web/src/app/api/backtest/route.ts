/**
 * POST /api/backtest
 *
 * Runs the deterministic analysis engine against historical candles and
 * returns per-pair + aggregate metrics. Read-only — never executes trades.
 *
 * Body: {
 *   timeframe: '1m'|'5m'|'15m'|'1h'|'4h'|'1d'|'1w',
 *   pairs?: string[],          // defaults to getActivePairs()
 *   exchange?: string,         // kraken | binance-us | coinbase (default kraken)
 *   limit?: number,            // candles per pair, 50..1000 (default 500)
 *   equity?: number,           // starting equity USD (default 100)
 * }
 */
import type { NextRequest } from 'next/server';
import {
  fetchHistoricalCandles,
  runBacktest,
  computeBacktestMetrics,
  type AnalysisTimeframe,
  type BacktestResult,
  type BacktestTrade,
} from '@b1dz/source-crypto-trade';
import { getActivePairs } from '@b1dz/source-crypto-arb';
import { authenticate, unauthorized } from '@/lib/api-auth';

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

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as BacktestRequest;
  const timeframe = (body.timeframe ?? '5m') as AnalysisTimeframe;
  if (!TIMEFRAMES.includes(timeframe)) {
    return Response.json({ error: `invalid timeframe "${timeframe}"`, validTimeframes: TIMEFRAMES }, { status: 400 });
  }
  const rawExchange = (body.exchange ?? 'kraken').toLowerCase();
  const exchangesToRun: string[] = rawExchange === 'all'
    ? [...EXCHANGE_LIST]
    : [rawExchange];
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

  const perPair: Array<{ pair: string; exchange: string; candles: number; result: BacktestResult | null; error: string | null }> = [];
  const aggregateTrades: BacktestTrade[] = [];
  const perExchange: Record<string, { trades: number; netPnl: number; grossPnl: number; fees: number; succeeded: number; skipped: number; failed: number }> = {};
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  let totalCandles = 0;

  for (const ex of exchangesToRun) {
    perExchange[ex] = { trades: 0, netPnl: 0, grossPnl: 0, fees: 0, succeeded: 0, skipped: 0, failed: 0 };
    for (const pair of pairs) {
      try {
        const candles = await fetchHistoricalCandles(ex, pair, timeframe, limit);
        if (candles.length < 50) {
          perPair.push({ pair, exchange: ex, candles: candles.length, result: null, error: 'insufficient candles' });
          skipped++;
          perExchange[ex].skipped++;
          continue;
        }
        const assumptions: Record<string, number> = { startingEquityUsd: equity };
        if (feeRate !== undefined) assumptions.feeRate = feeRate;
        if (slippagePct !== undefined) assumptions.slippagePct = slippagePct;
        if (spreadPct !== undefined) assumptions.spreadPct = spreadPct;
        const result = runBacktest({
          symbol: pair,
          exchange: ex,
          candles,
          assumptions,
        });
        perPair.push({ pair, exchange: ex, candles: candles.length, result, error: null });
        aggregateTrades.push(...result.trades);
        totalCandles += candles.length;
        succeeded++;
        perExchange[ex].succeeded++;
        perExchange[ex].trades += result.trades.length;
        perExchange[ex].netPnl += result.trades.reduce((sum, t) => sum + t.netPnl, 0);
        perExchange[ex].grossPnl += result.trades.reduce((sum, t) => sum + t.grossPnl, 0);
        perExchange[ex].fees += result.trades.reduce((sum, t) => sum + t.fees, 0);
      } catch (e) {
        perPair.push({ pair, exchange: ex, candles: 0, result: null, error: (e as Error).message.slice(0, 160) });
        failed++;
        perExchange[ex].failed++;
      }
    }
  }

  const aggregateMetrics = computeBacktestMetrics(aggregateTrades, equity * Math.max(1, succeeded));
  const totalNetPnl = aggregateTrades.reduce((sum, t) => sum + t.netPnl, 0);
  const totalGrossPnl = aggregateTrades.reduce((sum, t) => sum + t.grossPnl, 0);
  const totalFees = aggregateTrades.reduce((sum, t) => sum + t.fees, 0);
  const winningTrades = aggregateTrades.filter((t) => t.netPnl >= 0);
  const losingTrades = aggregateTrades.filter((t) => t.netPnl < 0);
  const totalCapitalUsd = equity * Math.max(1, succeeded);
  const durationMs = Date.now() - startedAt;
  console.log(`[api/backtest] done user=${auth.userId.slice(0, 8)} ok=${succeeded} skip=${skipped} fail=${failed} trades=${aggregateTrades.length} net=$${totalNetPnl.toFixed(2)} duration=${durationMs}ms`);

  return Response.json({
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
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      totalCapitalUsd,
      winningPairs: perPair.filter((p) => p.result && p.result.metrics.totalReturn > 0).length,
      losingPairs: perPair.filter((p) => p.result && p.result.metrics.totalReturn < 0).length,
    },
    summary: { succeeded, skipped, failed, pairsRequested: pairs.length * exchangesToRun.length, durationMs },
  });
}
