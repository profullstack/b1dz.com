/**
 * b1dz audit-arb — cross-exchange spread feasibility check.
 *
 * Does NOT simulate execution. Answers the prior question: "over the
 * last N hours, how often did a cross-exchange spread exist that would
 * have been net-positive after fees?" If this is zero or near-zero,
 * the inventory-arb executor cannot make money no matter how well it
 * executes. If it's non-trivial, then execution quality determines
 * whether the theoretical edge survives.
 *
 * Approach: fetch 1h (or --timeframe) candles from each exchange for
 * each pair, align by timestamp, and at each bar compute the best
 * cross-exchange net-of-fees edge treating bar-close as mid price.
 *
 * Mid-price proxy UNDERCOUNTS opportunities (real bid/ask crossings
 * within a bar occur more often than bar-close readings) but gives a
 * conservative lower bound.
 */
import { fetchHistoricalCandles, type AnalysisTimeframe, type Candle } from '@b1dz/source-crypto-trade';
import { getActivePairs, getPerExchangeVolumes } from '@b1dz/source-crypto-arb';

/** Both exchanges must clear this 24h volume for a pair to be considered tradeable. */
const MIN_EACH_EXCHANGE_VOL_USD = 100_000;
/** Direction bias ratio: if >0.8 of crossings go one way, treat as stale/phantom. */
const MAX_DIRECTION_BIAS = 0.8;

const TAKER_FEES: Record<string, number> = {
  kraken: 0.0026,
  'binance-us': 0.001,
  coinbase: 0.006,
};
const EXCHANGES = Object.keys(TAKER_FEES) as Array<keyof typeof TAKER_FEES>;

interface AuditArgs {
  timeframe: AnalysisTimeframe;
  limit: number;
  pairs: string[] | null;
  positionUsd: number;
}

function parseArgs(argv: string[]): AuditArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = 'true';
    }
  }
  const timeframe = (flags.timeframe ?? '1h') as AnalysisTimeframe;
  const limit = Math.max(50, Math.min(1000, Number.parseInt(flags.limit ?? '720', 10)));
  const pairsArg = flags.pair ?? flags.pairs;
  const pairs = pairsArg ? pairsArg.split(',').map((p) => p.trim()).filter(Boolean) : null;
  const positionUsd = Number.parseFloat(flags.position ?? '100');
  return { timeframe, limit, pairs, positionUsd: Number.isFinite(positionUsd) && positionUsd > 0 ? positionUsd : 100 };
}

function fmtUsd(value: number): string {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function fmtPct(value: number, digits = 3): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

interface BarCrossing {
  ts: number;
  buyExchange: string;
  sellExchange: string;
  buyPrice: number;
  sellPrice: number;
  netPct: number; // net of fees, as % of buyPrice
}

function bestCrossingAt(closesByExchange: Record<string, number>): BarCrossing | null {
  let best: BarCrossing | null = null;
  for (const buyEx of EXCHANGES) {
    for (const sellEx of EXCHANGES) {
      if (buyEx === sellEx) continue;
      const buyPrice = closesByExchange[buyEx];
      const sellPrice = closesByExchange[sellEx];
      if (!Number.isFinite(buyPrice) || !Number.isFinite(sellPrice) || buyPrice <= 0 || sellPrice <= 0) continue;
      const grossPerUnit = sellPrice - buyPrice;
      const fees = buyPrice * TAKER_FEES[buyEx] + sellPrice * TAKER_FEES[sellEx];
      const netPerUnit = grossPerUnit - fees;
      if (netPerUnit <= 0) continue;
      const netPct = (netPerUnit / buyPrice) * 100;
      if (!best || netPct > best.netPct) {
        best = {
          ts: 0,
          buyExchange: buyEx,
          sellExchange: sellEx,
          buyPrice,
          sellPrice,
          netPct,
        };
      }
    }
  }
  return best;
}

interface PairAuditResult {
  pair: string;
  barsSampled: number;
  barsWithArb: number;
  avgNetPctWhenPositive: number;
  maxNetPct: number;
  sumNetPct: number;
  topRoute: Record<string, number>; // "kraken->binance-us": count
}

async function auditPair(
  pair: string,
  timeframe: AnalysisTimeframe,
  limit: number,
  volumes: { kraken: Map<string, number>; coinbase: Map<string, number>; 'binance-us': Map<string, number> },
): Promise<PairAuditResult | { skip: true; reason: string } | null> {
  // Sanity filter #1: both exchanges must clear a minimum 24h volume. If
  // one exchange has a stale/delisted product the candles will still
  // return a price, but you can't actually trade against it.
  const usableExchanges = EXCHANGES.filter((ex) => (volumes[ex as keyof typeof volumes].get(pair) ?? 0) >= MIN_EACH_EXCHANGE_VOL_USD);
  if (usableExchanges.length < 2) {
    return { skip: true, reason: `only ${usableExchanges.length} exchange(s) have >$${MIN_EACH_EXCHANGE_VOL_USD / 1000}k 24h vol` };
  }

  const exchangeCandles = await Promise.all(
    usableExchanges.map(async (ex) => {
      try {
        const c = await fetchHistoricalCandles(ex, pair, timeframe, limit);
        return { exchange: ex, candles: c };
      } catch {
        return { exchange: ex, candles: [] as Candle[] };
      }
    }),
  );
  const usable = exchangeCandles.filter((e) => e.candles.length >= 50);
  if (usable.length < 2) return { skip: true, reason: 'insufficient candles' };

  // Sanity filter #2: candle staleness. Each exchange's latest candle
  // must be within 2x the bar interval of the latest overall. A lagging
  // exchange implies its API is returning stale data.
  const latestTimes = usable.map((e) => e.candles.at(-1)!.time);
  const mostRecent = Math.max(...latestTimes);
  const barMs = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000 }[timeframe];
  const staleThresholdMs = 2 * barMs;
  const allFresh = usable.every((e) => (mostRecent - e.candles.at(-1)!.time) <= staleThresholdMs);
  if (!allFresh) {
    return { skip: true, reason: 'stale candles on at least one exchange' };
  }

  // Build a timestamp → {exchange: close} map.
  const byTs = new Map<number, Record<string, number>>();
  for (const { exchange, candles } of usable) {
    for (const c of candles) {
      const bucket = byTs.get(c.time) ?? {};
      bucket[exchange] = c.close;
      byTs.set(c.time, bucket);
    }
  }

  let barsSampled = 0;
  let barsWithArb = 0;
  let maxNetPct = 0;
  let sumNetPct = 0;
  let positivePctSum = 0;
  const topRoute: Record<string, number> = {};
  for (const [, closes] of byTs) {
    if (Object.keys(closes).length < 2) continue;
    barsSampled++;
    const crossing = bestCrossingAt(closes);
    if (!crossing) continue;
    barsWithArb++;
    positivePctSum += crossing.netPct;
    sumNetPct += crossing.netPct;
    if (crossing.netPct > maxNetPct) maxNetPct = crossing.netPct;
    const key = `${crossing.buyExchange}->${crossing.sellExchange}`;
    topRoute[key] = (topRoute[key] ?? 0) + 1;
  }

  if (barsSampled === 0) return null;

  // Sanity filter #3: directional bias. Real arb oscillates both ways.
  // If >MAX_DIRECTION_BIAS of crossings are in one direction, one side's
  // quotes are drifting away from truth (stale or asset mismatch) and
  // the "edge" isn't capturable.
  const routeCounts = Object.values(topRoute);
  const totalRoutes = routeCounts.reduce((a, b) => a + b, 0);
  const maxDirection = Math.max(...routeCounts, 0);
  const biased = totalRoutes > 0 && (maxDirection / totalRoutes) > MAX_DIRECTION_BIAS;
  if (biased) {
    return { skip: true, reason: `one-sided crossings (${((maxDirection / totalRoutes) * 100).toFixed(0)}% one direction — stale quote)` };
  }

  return {
    pair,
    barsSampled,
    barsWithArb,
    avgNetPctWhenPositive: barsWithArb > 0 ? positivePctSum / barsWithArb : 0,
    maxNetPct,
    sumNetPct,
    topRoute,
  };
}

function topRouteLabel(topRoute: Record<string, number>): string {
  const entries = Object.entries(topRoute).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '-';
  return entries.slice(0, 2).map(([route, n]) => `${route}(${n})`).join(', ');
}

export async function runAuditArbCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  let pairs = args.pairs;
  if (!pairs) {
    process.stdout.write('discovering active pairs...');
    pairs = await getActivePairs();
    console.log(` ${pairs.length} pairs`);
    if (pairs.length === 0) {
      console.log('no active pairs — pass --pair BTC-USD,ETH-USD');
      return;
    }
  }

  console.log(`b1dz audit-arb  tf=${args.timeframe}  limit=${args.limit}  position=$${args.positionUsd}  pairs=${pairs.length}`);
  console.log(`(using bar-close as mid-price proxy; filters: vol>$${MIN_EACH_EXCHANGE_VOL_USD / 1000}k both ex, fresh candles, no directional bias)\n`);

  process.stdout.write('fetching 24h volumes for sanity filter...');
  const volumes = await getPerExchangeVolumes();
  console.log(` ok (kraken=${volumes.kraken.size} coinbase=${volumes.coinbase.size} binance-us=${volumes['binance-us'].size})\n`);

  const results: PairAuditResult[] = [];
  let skippedCount = 0;
  for (const pair of pairs) {
    try {
      const r = await auditPair(pair, args.timeframe, args.limit, volumes);
      if (!r) {
        console.log(`  ${pair.padEnd(16)} insufficient data`);
        continue;
      }
      if ('skip' in r) {
        skippedCount++;
        // Only log a few so we don't drown the user in "skipped" lines.
        if (skippedCount <= 5) console.log(`  ${pair.padEnd(16)} skipped — ${r.reason}`);
        continue;
      }
      results.push(r);
      const pctBars = (r.barsWithArb / r.barsSampled) * 100;
      console.log(`  ${pair.padEnd(16)} bars=${String(r.barsSampled).padStart(4)} arb=${String(r.barsWithArb).padStart(3)} (${pctBars.toFixed(1)}%) avg=${fmtPct(r.avgNetPctWhenPositive)} max=${fmtPct(r.maxNetPct)} route=${topRouteLabel(r.topRoute)}`);
    } catch (e) {
      console.log(`  ${pair.padEnd(16)} FAILED: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  if (skippedCount > 5) console.log(`  ... and ${skippedCount - 5} more pairs skipped by sanity filters`);

  if (results.length === 0) {
    console.log('\nno pairs had usable data across exchanges.');
    return;
  }

  const totalBars = results.reduce((s, r) => s + r.barsSampled, 0);
  const totalArbBars = results.reduce((s, r) => s + r.barsWithArb, 0);
  const sumOfAvgWeighted = results.reduce((s, r) => s + r.sumNetPct, 0);
  const avgAcrossArbBars = totalArbBars > 0 ? sumOfAvgWeighted / totalArbBars : 0;

  // Rough expected daily $ edge (if we captured every arb bar at position size):
  const barMinutes = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 }[args.timeframe] ?? 60;
  const windowHours = (totalBars * barMinutes) / results.length / 60;
  const totalEdgeUsd = (sumOfAvgWeighted / 100) * args.positionUsd;
  const edgePerDay = windowHours > 0 ? (totalEdgeUsd / windowHours) * 24 : 0;

  const verdict = avgAcrossArbBars > 0.05
    ? '\x1b[32mEDGE EXISTS'
    : avgAcrossArbBars > 0.01
      ? '\x1b[33mMARGINAL EDGE'
      : '\x1b[31mNO USABLE EDGE';
  const reset = '\x1b[0m';
  const line = '═'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${verdict}${reset}`);
  console.log(line);
  console.log(`  Bars sampled:      ${totalBars} across ${results.length} pairs`);
  console.log(`  Bars w/ arb edge:  ${totalArbBars} (${((totalArbBars / Math.max(1, totalBars)) * 100).toFixed(1)}%)`);
  console.log(`  Avg edge per arb bar: ${fmtPct(avgAcrossArbBars)} (${fmtUsd((avgAcrossArbBars / 100) * args.positionUsd)} on $${args.positionUsd})`);
  console.log(`  Theoretical total:    ${fmtUsd(totalEdgeUsd)} over ~${windowHours.toFixed(1)}h`);
  console.log(`  Theoretical $/day:    ${fmtUsd(edgePerDay)} (if every opportunity captured, which is optimistic)`);
  console.log('');
  console.log('  NOTE: bar-close mid-price UNDERCOUNTS opportunities. Real bid/ask');
  console.log('  crossings occur more often intra-bar. But actual execution LOSES');
  console.log('  some opportunities to latency/fills, so the real number is in');
  console.log('  between this lower bound and a fill-simulated upper bound.');
  console.log(line);
}
