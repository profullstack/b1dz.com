/**
 * Strategy correlation — catching a catalogue full of near-identical copies.
 *
 * WHY THIS EXISTS
 *
 * A generator that sweeps RSI periods 2..50 with fixed thresholds produces 49
 * strategies. Most of them are reskins: the per-bar signal vectors correlate
 * > 0.9, the P&L streams move together, and listing all 49 fills pages with
 * duplicates. A buyer scrolling past ten names that all behave identically
 * learns that the store's curation is cosmetic, and a buyer who buys three of
 * them finds they all blow up on the same day.
 *
 * This module measures per-bar signal alignment (period-2 RSI is faster to fire
 * but pulls the same trigger) and per-bucket return alignment (they make and
 * lose money on the same trades). Either metric alone can miss reskins:
 * signal correlation misses strategies that agree on direction but differ in
 * sizing, and return correlation can be high by chance on a short series.
 * Together they give a usable pairwise distance.
 *
 * THE FAILURE MODE
 *
 * Pearson's r on raw signal vectors over 2,000 bars looks significant at
 * anything > 0.04, so a findDuplicates() threshold of 0.8 is not "p < 0.05"
 * loose — it is genuinely tight, and a pair above it IS functionally identical.
 * But on a 30-trade P&L stream, 0.8 can happen from a single shared windfall
 * week. The combined gate is the only safe one.
 */
import type { MarketSnapshot, StrategyPlugin } from '@b1dz/core';
import type { BacktestTrade } from '@b1dz/source-strategies';

/**
 * Pearson correlation coefficient.
 *
 * Degenerate cases:
 *   - vectors of length < 2 → 0 (undefined)
 *   - standard deviation is zero → 0 (undefined — every point = mean, and r
 *     measures linear deviation)
 *   - a non-finite observation leaks through → 0 (a bad tick is not a signal)
 */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;

  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    if (!Number.isFinite(da) || !Number.isFinite(db)) return 0;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (!(va > 0) || !(vb > 0)) return 0;
  return cov / Math.sqrt(va * vb);
}

/**
 * Signal vector: per-bar direction implied by the plugin's evaluate() output.
 *
 *   +1 = buy  (or a trailing hold-buy)
 *   −1 = sell
 *    0 = no signal (or error — a broken evaluate() is "no position" here)
 *
 * Two strategies that agree on direction will correlate, even if one acts
 * earlier (shorter indicators). This is the tighter of the two filters for
 * period-sweep clones: the Pearson of binary vectors still catches near-
 * identical timing.
 */
export function signalVector(plugin: StrategyPlugin, snapshots: MarketSnapshot[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i]!;
    const history = snapshots.slice(0, i);
    let signal = null;
    try {
      signal = plugin.evaluate(snap, history);
    } catch {
      signal = null;
    }
    if (!signal) {
      out.push(0);
      continue;
    }
    out.push(signal.side === 'buy' ? 1 : -1);
  }
  return out;
}

/**
 * Signal alignment between two plugins over the same snapshots.
 *
 * Range [−1, 1]. Degenerate if either strategy throws on > half the bars or is
 * permanently silent — that returns 0, not NaN, because NaN passes every > check
 * and a catalog correlation gate of `r < 0.8` would let NaN through silently.
 */
export function signalCorrelation(
  pluginA: StrategyPlugin,
  pluginB: StrategyPlugin,
  snapshots: MarketSnapshot[],
): number {
  return pearson(signalVector(pluginA, snapshots), signalVector(pluginB, snapshots));
}

/**
 * Bucket nominal profit (roughly proceeds − cost, not the compounded netMultiple
 * curve) into uniform time windows so return correlation is per-period rather
 * than per-bar — a per-bar correlation on 2,000 days with maybe 50 return
 * observations would be dominated by zeros and artificially low.
 *
 * Bucket edges are aligned to the first bar's timestamp so every strategy run
 * over the same series gets the same buckets; the correlation is then
 * comparable across runs.
 */
function bucketReturns(
  trades: BacktestTrade[],
  startTs: number,
  endTs: number,
  bucketMs: number,
): number[] {
  if (bucketMs <= 0 || startTs >= endTs) return [];
  const n = Math.ceil((endTs - startTs) / bucketMs);
  const out = new Array<number>(n).fill(0);
  for (const t of trades) {
    const bucket = Math.floor((t.exitTs - startTs) / bucketMs);
    if (bucket < 0 || bucket >= n) continue;
    out[bucket]! += t.profit;
  }
  return out;
}

/**
 * Pearson over binned nominal P&L.
 *
 * Default bucket is one calendar week (7 days × 86400 s × 1000 ms) — tight
 * enough to catch strategies that consistently exploit the same pattern,
 * loose enough that the noise of which exact bar they entered on doesn't
 * dominate the correlation.
 */
export function returnCorrelation(
  tradesA: BacktestTrade[],
  tradesB: BacktestTrade[],
  startTs: number,
  endTs: number,
  bucketMs = 7 * 24 * 60 * 60 * 1000,
): number {
  return pearson(
    bucketReturns(tradesA, startTs, endTs, bucketMs),
    bucketReturns(tradesB, startTs, endTs, bucketMs),
  );
}

/**
 * Pair of minimised comparisons for one candidate against a single catalogue
 * entry — per-bar signal correlation and per-week return correlation.
 */
export interface CorrelationPair {
  signal: number;
  /** Signal correlation over the per-bar vectors. */
  return: number;
  /** Per-bucket return Pearson. */
  strategyId: string;
}

/**
 * Find catalogue entries whose signal AND return correlations both exceed
 * `threshold`, in either direction. A pair where both metrics clear the
 * threshold is a duplicate and shouldn't be listed separately.
 */
export function findDuplicates(
  candidatePlugin: StrategyPlugin,
  candidateTrades: BacktestTrade[],
  catalog: { plugin: StrategyPlugin; trades: BacktestTrade[]; id: string }[],
  snapshots: MarketSnapshot[],
  threshold = 0.8,
): CorrelationPair[] {
  if (snapshots.length === 0) return [];
  const startTs = snapshots[0]!.ts;
  const endTs = snapshots[snapshots.length - 1]!.ts;
  const out: CorrelationPair[] = [];
  for (const entry of catalog) {
    const sig = signalCorrelation(candidatePlugin, entry.plugin, snapshots);
    const ret = returnCorrelation(candidateTrades, entry.trades, startTs, endTs);
    if (sig > threshold && ret > threshold) {
      out.push({ signal: sig, return: ret, strategyId: entry.id });
    }
  }
  return out;
}
