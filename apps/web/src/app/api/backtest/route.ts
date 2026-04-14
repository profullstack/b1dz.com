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
const EXCHANGES = new Set(['kraken', 'binance-us', 'coinbase']);

export const maxDuration = 300;

interface BacktestRequest {
  timeframe?: string;
  pairs?: string[];
  exchange?: string;
  limit?: number;
  equity?: number;
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as BacktestRequest;
  const timeframe = (body.timeframe ?? '5m') as AnalysisTimeframe;
  if (!TIMEFRAMES.includes(timeframe)) {
    return Response.json({ error: `invalid timeframe "${timeframe}"`, validTimeframes: TIMEFRAMES }, { status: 400 });
  }
  const exchange = (body.exchange ?? 'kraken').toLowerCase();
  if (!EXCHANGES.has(exchange)) {
    return Response.json({ error: `invalid exchange "${exchange}"`, validExchanges: [...EXCHANGES] }, { status: 400 });
  }
  const limit = Math.max(50, Math.min(1000, Number(body.limit ?? 500)));
  const equity = Math.max(1, Number(body.equity ?? 100));

  const pairs = Array.isArray(body.pairs) && body.pairs.length > 0
    ? body.pairs.map(String).filter(Boolean)
    : await getActivePairs();

  if (pairs.length === 0) {
    return Response.json({ error: 'no pairs available — pass pairs in body or wait for discovery' }, { status: 400 });
  }

  const startedAt = Date.now();
  console.log(`[api/backtest] user=${auth.userId.slice(0, 8)} tf=${timeframe} exchange=${exchange} pairs=${pairs.length} limit=${limit}`);

  const perPair: Array<{ pair: string; candles: number; result: BacktestResult | null; error: string | null }> = [];
  const aggregateTrades: BacktestTrade[] = [];
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  let totalCandles = 0;

  for (const pair of pairs) {
    try {
      const candles = await fetchHistoricalCandles(exchange, pair, timeframe, limit);
      if (candles.length < 50) {
        perPair.push({ pair, candles: candles.length, result: null, error: 'insufficient candles' });
        skipped++;
        continue;
      }
      const result = runBacktest({
        symbol: pair,
        exchange,
        candles,
        assumptions: { startingEquityUsd: equity },
      });
      perPair.push({ pair, candles: candles.length, result, error: null });
      aggregateTrades.push(...result.trades);
      totalCandles += candles.length;
      succeeded++;
    } catch (e) {
      perPair.push({ pair, candles: 0, result: null, error: (e as Error).message.slice(0, 160) });
      failed++;
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
    exchange,
    limit,
    equity,
    pairs: perPair,
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
    summary: { succeeded, skipped, failed, pairsRequested: pairs.length, durationMs },
  });
}
