/**
 * DCA backtest CLI — fetches historical candles from each configured
 * exchange for each configured coin, replays the DCA planner across
 * the window, and prints an analytics table.
 *
 * Usage:
 *   pnpm --filter @b1dz/cli exec tsx src/backtest-dca.ts
 *   pnpm --filter @b1dz/cli exec tsx src/backtest-dca.ts --days 90 --equity 2000
 *
 * Reads DCA config from env (DCA_COINS, DCA_EXCHANGES, DCA_INTERVAL_MS,
 * DCA_TOTAL_ALLOCATION_PCT, DCA_MAX_COINS). Falls back to defaults.
 */

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env') });

const {
  dcaConfigFromEnv,
  runDcaBacktest,
} = await import('@b1dz/source-crypto-trade');
const { fetchHistoricalCandles } = await import('@b1dz/source-crypto-trade');

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) { out[k] = v; i++; }
    else out[k] = 'true';
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const days = Math.max(1, Math.min(365, Number.parseInt(args.days ?? '30', 10)));
const equity = Math.max(1, Number.parseFloat(args.equity ?? '1000'));
const feeRate = Number.parseFloat(args.fee ?? '0.003');

const cfg = dcaConfigFromEnv();

console.log('── DCA Backtest ───────────────────────────────────────');
console.log(`period:     ${days} days`);
console.log(`equity:     $${equity.toFixed(2)}`);
console.log(`fee rate:   ${(feeRate * 100).toFixed(2)}%`);
console.log(`interval:   ${(cfg.intervalMs / 86_400_000).toFixed(1)} day(s)`);
console.log(`coins:      ${cfg.coins.join(', ')}`);
console.log(`exchanges:  ${cfg.exchanges.join(', ')}`);
console.log(`allocation: ${cfg.totalAllocationPct}% total → $${(equity * cfg.totalAllocationPct / 100 / cfg.exchanges.length / cfg.maxCoins).toFixed(2)} per buy`);
console.log('');

// Fetch candles per (exchange, coin).
const candles = new Map<string, { time: number; open: number; high: number; low: number; close: number; volume: number }[]>();
console.log('fetching historical candles...');
const fetchStart = Date.now();
const fetchPromises: Promise<void>[] = [];
for (const exchange of cfg.exchanges) {
  for (const coin of cfg.coins) {
    const pair = `${coin}-USD`;
    const key = `${exchange}:${coin}`;
    fetchPromises.push(
      fetchHistoricalCandles(exchange, pair, '1d', days)
        .then((bars) => { candles.set(key, bars); })
        .catch((e) => {
          console.log(`  ✗ ${key}: ${(e as Error).message.slice(0, 80)}`);
          candles.set(key, []);
        }),
    );
  }
}
await Promise.all(fetchPromises);
console.log(`fetched ${candles.size} series in ${Date.now() - fetchStart}ms`);
console.log('');

const result = runDcaBacktest({
  config: cfg,
  candles: candles as never,
  equityUsd: equity,
  feeRate,
});

console.log('── Per-position ───────────────────────────────────────');
console.log('exchange    coin   buys    spent     fees    avg cost     final    value      PnL');
console.log('───────────────────────────────────────────────────────────────────────────────────');
for (const p of result.positions) {
  const pnlColor = p.unrealizedPnlUsd >= 0 ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log([
    p.exchange.padEnd(11),
    p.coin.padEnd(5),
    String(p.buys).padStart(5),
    `$${p.totalUsdSpent.toFixed(2)}`.padStart(9),
    `$${p.totalFeesUsd.toFixed(2)}`.padStart(8),
    `$${p.avgCostBasis.toFixed(2)}`.padStart(11),
    `$${p.finalPrice.toFixed(2)}`.padStart(9),
    `$${p.finalValueUsd.toFixed(2)}`.padStart(9),
    `${pnlColor}${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd.toFixed(2)} (${p.unrealizedPnlPct >= 0 ? '+' : ''}${p.unrealizedPnlPct.toFixed(1)}%)${reset}`,
  ].join(' '));
}

console.log('');
console.log('── Totals ─────────────────────────────────────────────');
console.log(`buys:        ${result.totals.buys}`);
console.log(`spent:       $${result.totals.usdSpent.toFixed(2)}`);
console.log(`fees:        $${result.totals.feesUsd.toFixed(2)}`);
console.log(`final value: $${result.totals.finalValueUsd.toFixed(2)}`);
const totColor = result.totals.unrealizedPnlUsd >= 0 ? '\x1b[32m' : '\x1b[31m';
console.log(`PnL:         ${totColor}${result.totals.unrealizedPnlUsd >= 0 ? '+' : ''}$${result.totals.unrealizedPnlUsd.toFixed(2)} (${result.totals.unrealizedPnlPct >= 0 ? '+' : ''}${result.totals.unrealizedPnlPct.toFixed(2)}%)\x1b[0m`);
