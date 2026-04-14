import { B1dzClient, type BacktestRunOptions, type BacktestRunResponse } from '@b1dz/sdk';
import { loadCredentials } from './auth.js';

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
const EXCHANGES = ['kraken', 'binance-us', 'coinbase'] as const;

type Timeframe = typeof TIMEFRAMES[number];
type Exchange = typeof EXCHANGES[number];

function parseArgs(argv: string[]): {
  timeframe: Timeframe;
  pairs: string[] | undefined;
  exchange: Exchange;
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

  const timeframe = (positional[0] ?? flags.timeframe ?? '5m') as Timeframe;
  if (!TIMEFRAMES.includes(timeframe)) {
    throw new Error(`invalid timeframe "${timeframe}" — expected one of ${TIMEFRAMES.join(', ')}`);
  }
  const pairsArg = flags.pair ?? flags.pairs;
  const pairs = pairsArg
    ? pairsArg.split(',').map((p) => p.trim()).filter(Boolean)
    : undefined;
  const exchange = ((flags.exchange ?? 'kraken').toLowerCase()) as Exchange;
  if (!EXCHANGES.includes(exchange)) {
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

function printPairSummary(label: string, pair: BacktestRunResponse['pairs'][number]): void {
  if (!pair.result) {
    console.log(`  ${label.padEnd(22)} ${pair.error ?? 'no result'}`);
    return;
  }
  const m = pair.result.metrics;
  const pf = Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞';
  const trades = String(pair.result.trades.length).padStart(3);
  const ret = fmtPct(m.totalReturn).padStart(8);
  const win = `${m.winRate.toFixed(0).padStart(3)}%`;
  console.log(`  ${label.padEnd(22)} trades=${trades}  ret=${ret}  win=${win}  pf=${pf.padStart(5)}  DD=${m.maxDrawdown.toFixed(1).padStart(4)}%`);
}

function buildClient(): B1dzClient {
  const baseUrl = process.env.B1DZ_API_URL;
  if (!baseUrl) throw new Error('B1DZ_API_URL missing in .env');
  const creds = loadCredentials();
  if (!creds) throw new Error('not signed in — run `b1dz login` first');
  return new B1dzClient({
    baseUrl,
    tokens: { accessToken: creds.accessToken, refreshToken: creds.refreshToken },
  });
}

export async function runBacktestCli(argv: string[]): Promise<void> {
  const { timeframe, pairs, exchange, limit, equity } = parseArgs(argv);
  const client = buildClient();

  const opts: BacktestRunOptions = { timeframe, exchange, limit, equity };
  if (pairs) opts.pairs = pairs;

  console.log(`b1dz backtest → api  tf=${timeframe}  exchange=${exchange}  pairs=${pairs ? pairs.length : 'active'}  limit=${limit}  equity=$${equity}`);
  process.stdout.write('  running on server...');

  const start = Date.now();
  let response: BacktestRunResponse;
  try {
    response = await client.backtest.run(opts);
  } catch (e) {
    console.log(' FAILED');
    throw e;
  }
  console.log(` done in ${((Date.now() - start) / 1000).toFixed(1)}s (server ${response.summary.durationMs}ms)\n`);

  for (const pair of response.pairs) {
    printPairSummary(`${response.exchange}:${pair.pair}`, pair);
  }

  const m = response.aggregate.metrics;
  const agg = response.aggregate;
  const pf = Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞';
  if (response.aggregate.trades > 0) {
    console.log('');
    console.log(formatBucketTable('by regime', m.performanceByRegime));
    console.log(formatBucketTable('by volatility', m.performanceByVolatilityBucket));
    console.log(formatBucketTable('by symbol', m.performanceBySymbol));
  }

  const { succeeded, skipped, failed, pairsRequested } = response.summary;
  const verdict = agg.totalNetPnl >= 0 ? 'PROFITABLE' : 'LOSING';
  const verdictColor = agg.totalNetPnl >= 0 ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const line = '═'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${bold}${verdictColor}STRATEGY VERDICT: ${verdict}${reset}`);
  console.log(line);
  console.log(`  ${bold}Net P&L:${reset}         ${verdictColor}${fmtUsd(agg.totalNetPnl)}${reset}  (${fmtPct(m.totalReturn)} on $${agg.totalCapitalUsd.toFixed(0)} deployed)`);
  console.log(`  Gross P&L:       ${fmtUsd(agg.totalGrossPnl)}`);
  console.log(`  Fees paid:       ${fmtUsd(-agg.totalFees)}`);
  console.log(`  Trades:          ${agg.trades}  (${agg.winningTrades} win / ${agg.losingTrades} loss, ${m.winRate.toFixed(1)}% win rate)`);
  console.log(`  Profit factor:   ${pf}   Expectancy: ${fmtUsd(m.expectancy)}/trade`);
  console.log(`  Max drawdown:    ${m.maxDrawdown.toFixed(2)}%   Sharpe: ${m.sharpe.toFixed(2)}`);
  console.log(`  Avg hold:        ${m.averageHoldMinutes.toFixed(1)}m   Trades/day: ${m.tradesPerDay.toFixed(2)}`);
  console.log(`  Pairs:           ${succeeded} ran (${agg.winningPairs} profitable, ${agg.losingPairs} losing), ${skipped} skipped, ${failed} failed — of ${pairsRequested}`);
  console.log(line);
}
