import {
  fetchHistoricalCandles,
  runBacktest,
  type AnalysisTimeframe,
  type BacktestResult,
  type Candle,
} from '@b1dz/source-crypto-trade';

const TIMEFRAMES: readonly AnalysisTimeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const EXCHANGES = ['kraken', 'binance-us', 'coinbase'] as const;

function parseArgs(argv: string[]): {
  timeframe: AnalysisTimeframe;
  pairs: string[];
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
  const pairsArg = flags.pair ?? flags.pairs ?? 'BTC-USD,ETH-USD,SOL-USD';
  const pairs = pairsArg.split(',').map((p) => p.trim()).filter(Boolean);
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

function printResult(label: string, result: BacktestResult, equity: number, candles: number): void {
  const m = result.metrics;
  const profitFactor = Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞';
  console.log(`\n── ${label} ──  candles=${candles}  trades=${result.trades.length}`);
  console.log(`  return=${fmtPct(m.totalReturn)}  win=${m.winRate.toFixed(1)}%  pf=${profitFactor}  exp=${fmtUsd(m.expectancy)}`);
  console.log(`  sharpe=${m.sharpe.toFixed(2)}  maxDD=${m.maxDrawdown.toFixed(2)}%  avgHold=${m.averageHoldMinutes.toFixed(1)}m  trades/day=${m.tradesPerDay.toFixed(2)}`);
  if (result.trades.length > 0) {
    console.log(formatBucketTable('by regime', m.performanceByRegime));
    console.log(formatBucketTable('by volatility', m.performanceByVolatilityBucket));
  }
  void equity;
}

export async function runBacktestCli(argv: string[]): Promise<void> {
  const { timeframe, pairs, exchange, limit, equity } = parseArgs(argv);
  console.log(`b1dz backtest  tf=${timeframe}  exchange=${exchange}  pairs=${pairs.join(',')}  limit=${limit}  equity=$${equity}`);

  const aggregateTrades: BacktestResult['trades'] = [];
  let aggregateCandles = 0;

  for (const pair of pairs) {
    process.stdout.write(`  fetching ${exchange}:${pair} ${timeframe}...`);
    let candles: Candle[];
    try {
      candles = await fetchHistoricalCandles(exchange, pair, timeframe, limit);
    } catch (e) {
      console.log(` FAILED: ${(e as Error).message}`);
      continue;
    }
    if (candles.length < 50) {
      console.log(` too few candles (${candles.length}) — skipping`);
      continue;
    }
    console.log(` ${candles.length} candles`);
    const result = runBacktest({
      symbol: pair,
      exchange,
      candles,
      assumptions: { startingEquityUsd: equity },
    });
    aggregateCandles += candles.length;
    aggregateTrades.push(...result.trades);
    printResult(`${exchange}:${pair}`, result, equity, candles.length);
  }

  if (pairs.length > 1) {
    const totalNet = aggregateTrades.reduce((sum, t) => sum + t.netPnl, 0);
    const wins = aggregateTrades.filter((t) => t.netPnl >= 0).length;
    console.log(`\n── TOTAL ──`);
    console.log(`  trades=${aggregateTrades.length}  net=${fmtUsd(totalNet)}  win=${aggregateTrades.length > 0 ? ((wins / aggregateTrades.length) * 100).toFixed(1) : '0.0'}%  candles=${aggregateCandles}`);
  }
}
