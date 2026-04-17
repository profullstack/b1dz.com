/**
 * DCA planner — pure decision logic.
 *
 *   decideDcaBuys(input) →
 *     an ordered list of (exchange, coin, usdAmount) buys to submit this tick.
 *
 * Rules:
 *   - Only configured exchanges + coins are eligible.
 *   - Only coins that pass the screening callback are eligible (mcap/volume
 *     thresholds reused from the main strategy — a coin that's unsellable
 *     is a coin we shouldn't DCA into either).
 *   - Per (exchange, coin), buy only if interval-since-last-buy ≥ intervalMs.
 *   - Per exchange, cap active distinct coins at maxCoins (counted against
 *     currentHoldings so we don't add a 4th when we already hold 3).
 *   - Per-buy USD size = (equity × perExchangePct/100) / maxCoins
 *     (divide the per-exchange DCA bucket evenly across the slots so we
 *     actually reach maxCoins positions rather than dumping it all on one).
 */

import type { DcaConfig } from './dca-config.js';

export interface DcaBuy {
  exchange: string;
  coin: string;
  usdAmount: number;
}

export interface DcaPlannerInput {
  config: DcaConfig;
  now: number;
  /** Total account equity across all exchanges, in USD. */
  equityUsd: number;
  /** Map<exchange, Set<coin>> of coins already held (for maxCoins slot check). */
  currentHoldings: Map<string, Set<string>>;
  /** Map<`${exchange}:${coin}`, lastBuyMs>. Omit for coins never DCA'd here. */
  lastBuyAt: Map<string, number>;
  /** Returns true if (exchange, coin) currently passes the volume / mcap
   *  / listing screens. Reject → skip that slot this tick. */
  isEligible: (exchange: string, coin: string) => boolean;
}

export function decideDcaBuys(input: DcaPlannerInput): DcaBuy[] {
  const { config, now, equityUsd, currentHoldings, lastBuyAt, isEligible } = input;
  if (!config.enabled) return [];
  if (!(equityUsd > 0)) return [];
  if (config.exchanges.length === 0 || config.coins.length === 0) return [];

  const perExchangePct = config.totalAllocationPct / config.exchanges.length;
  const perExchangeUsd = equityUsd * (perExchangePct / 100);
  if (!(perExchangeUsd > 0)) return [];
  const perBuyUsd = perExchangeUsd / config.maxCoins;
  if (!(perBuyUsd > 0)) return [];

  const buys: DcaBuy[] = [];
  for (const exchange of config.exchanges) {
    const held = currentHoldings.get(exchange) ?? new Set<string>();
    for (const coin of config.coins) {
      // Enforce max distinct coins per exchange — counting existing
      // holdings plus already-queued buys this tick.
      const slotsInUse = new Set([...held, ...buys.filter((b) => b.exchange === exchange).map((b) => b.coin)]);
      if (!slotsInUse.has(coin) && slotsInUse.size >= config.maxCoins) continue;

      if (!isEligible(exchange, coin)) continue;

      const key = `${exchange}:${coin}`;
      const last = lastBuyAt.get(key);
      // Never-bought-before → always eligible on first run. Only suppress
      // when there's an actual recorded buy within the interval window.
      if (last !== undefined && now - last < config.intervalMs) continue;

      buys.push({ exchange, coin, usdAmount: perBuyUsd });
    }
  }
  return buys;
}
