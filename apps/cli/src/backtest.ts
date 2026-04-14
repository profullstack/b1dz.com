import {
  computeBacktestMetrics,
  fetchHistoricalCandles,
  runBacktest,
  type AnalysisTimeframe,
  type BacktestResult,
  type Candle,
} from '@b1dz/source-crypto-trade';
import { getActivePairs } from '@b1dz/source-crypto-arb';

const TIMEFRAMES: readonly AnalysisTimeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const EXCHANGES = ['kraken', 'binance-us', 'coinbase'] as const;

function parseArgs(argv: string[]): {
  timeframe: AnalysisTimeframe;
  pairs: string[] | null;
  exchange: string;
  limit: number;
  equity: number;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(token);
    }
  }

  const timeframe = (positional[0] ?? flags.timeframe ?? '5m') as AnalysisTimeframe;
  if (!TIMEFRAMES.includes(timeframe)) {
    throw new Error(`invalid timeframe "${timeframe}" — expected one of ${TIMEFRAMES.join(', ')}`);
  }
  const pairsArg = flags.pair ?? flags.pairs;
  const pairs = pairsArg
    ? pairsArg.split(',').map((p) => p.trim()).filter(Boolean)
    : null;
  const exchange = (flags.exchange ?? 'kraken').toLowerCase();
  if (!EXCHANGES.includes(exchange as typeof EXCHANGES[number])) {
    throw new Error(`invalid exchange "${exchange}" — expected one of ${EXCHANGES.join(', ')}`);
  }
  const limit = Math.max(50, Math.min(1000, Number.parseInt(flags.limit ?? '500', 10)));
  const equity = Math.max(1, Number.parseFloat(flags.equity ?? '100'));
  return { timeframe, pairs, exchange, limit, equity };
}

function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return '∞';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function fmtUsd(value: number): string {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatBucketTable(title: string, buckets: Record<string, { trades: number; netPnl: number; wins: number; losses: number }>): string {
  const entries = Object.entries(buckets).sort((a, b) => b[1].netPnl - a[1].netPnl);
  if (entries.length === 0) return `  ${title}: (none)`;
  const lines = [`  ${title}:`];
  for (const [key, b] of entries) {
    const winRate = b.trades > 0 ? (b.wins / b.trades) * 100 : 0;
    lines.push(`    ${key.padEnd(20)} trades=${String(b.trades).padStart(3)}  win=${winRate.toFixed(0).padStart(2)}%  pnl=${fmtUsd(b.netPnl)}`);
  }
  return lines.join('\n');
}

function printPairSummary(label: string, result: BacktestResult): void {
  const m = result.metrics;
  const pf = Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞';
  const trades = String(result.trades.length).padStart(3);
  const ret = fmtPct(m.totalReturn).padStart(8);
  const win = `${m.winRate.toFixed(0).padStart(3)}%`;
  console.log(`  ${label.padEnd(22)} trades=${trades}  ret=${ret}  win=${win}  pf=${pf.padStart(5)}  DD=${m.maxDrawdown.toFixed(1).padStart(4)}%`);
}

function printAggregateReport(label: string, result: BacktestResult, candles: number): void {
  const m = result.metrics;
  const profitFactor = Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞';
  console.log(`\n── ${label} ──  candles=${candles}  trades=${result.trades.length}`);
  console.log(`  return=${fmtPct(m.totalReturn)}  win=${m.winRate.toFixed(1)}%  pf=${profitFactor}  exp=${fmtUsd(m.expectancy)}`);
  console.log(`  sharpe=${m.sharpe.toFixed(2)}  maxDD=${m.maxDrawdown.toFixed(2)}%  avgHold=${m.averageHoldMinutes.toFixed(1)}m  trades/day=${m.tradesPerDay.toFixed(2)}`);
  if (result.trades.length > 0) {
    console.log(formatBucketTable('by regime', m.performanceByRegime));
    console.log(formatBucketTable('by volatility', m.performanceByVolatilityBucket));
    console.log(formatBucketTable('by symbol', m.performanceBySymbol));
  }
}

export async function runBacktestCli(argv: string[]): Promise<void> {
  const { timeframe, pairs: pairOverride, exchange, limit, equity } = parseArgs(argv);
  let pairs = pairOverride;
  if (!pairs) {
    process.stdout.write('discovering active pairs...');
    pairs = await getActivePairs();
    console.log(` ${pairs.length} pairs`);
    if (pairs.length === 0) {
      console.log('no active pairs discovered — pass --pair BTC-USD,ETH-USD to override');
      return;
    }
  }
  console.log(`b1dz backtest  tf=${timeframe}  exchange=${exchange}  pairs=${pairs.length}  limit=${limit}  equity=$${equity}`);

  const aggregateTrades: BacktestResult['trades'] = [];
  let aggregateCandles = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const pair of pairs) {
    let candles: Candle[];
    try {
      candles = await fetchHistoricalCandles(exchange, pair, timeframe, limit);
    } catch (e) {
      console.log(`  ${`${exchange}:${pair}`.padEnd(22)} FAILED: ${(e as Error).message.slice(0, 60)}`);
      failed++;
      continue;
    }
    if (candles.length < 50) {
      console.log(`  ${`${exchange}:${pair}`.padEnd(22)} skipped (${candles.length} candles, need >=50)`);
      skipped++;
      continue;
    }
    const result = runBacktest({
      symbol: pair,
      exchange,
      candles,
      assumptions: { startingEquityUsd: equity },
    });
    aggregateCandles += candles.length;
    aggregateTrades.push(...result.trades);
    succeeded++;
    printPairSummary(`${exchange}:${pair}`, result);
  }

  const aggregateMetrics = computeBacktestMetrics(aggregateTrades, equity * Math.max(1, succeeded));
  printAggregateReport('AGGREGATE', { trades: aggregateTrades, metrics: aggregateMetrics }, aggregateCandles);
  console.log(`\n  pairs: ${succeeded} ran, ${skipped} skipped, ${failed} failed`);
}
