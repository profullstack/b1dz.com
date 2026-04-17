/**
 * Pure, venue-agnostic sizing helpers for SELL exits and BUY pre-flight.
 *
 * These exist because every CEX enforces its own minimum order filters
 * (`base_min_size` on Coinbase, `ordermin` on Kraken, `minQty` +
 * `minNotional` on Binance.US) and the native sell-sizing code used a
 * blanket 0.995× cushion against buy-fee skim — which collides with
 * coarse-grained `base_increment` tokens (e.g. RAVE-USD on Coinbase has
 * base_min_size 0.1, so 0.1 × 0.995 = 0.0995 floors to 0 and the order
 * rejects).
 *
 * The fix is to branch on the venue's own minimum: if the 0.995
 * cushioned size would drop below the venue minimum AND the wallet
 * actually holds ≥ minimum, drop the cushion. SELL-side fees on every
 * CEX we trade are quote-denominated or negligible, so selling the
 * live-reported available balance is safe.
 *
 * For BUY pre-flight we flip it around: refuse any buy that would
 * settle into an unsellable position (baseAmount below sell-side min
 * or notional below quote-min). Prevents the daemon from opening dust
 * trades it can't close.
 */

export interface VenueSellLimits {
  /** Minimum base amount per order. */
  baseMinSize?: number | null;
  /** Minimum quote (USD) notional per order. Coinbase only. */
  quoteMinSize?: number | null;
  /** Minimum quote notional enforced as a separate filter. Binance. */
  minNotional?: number | null;
}

/** Compute the SELL volume given live available balance, a cap (tracked
 *  position volume or liquidation target), and the venue's minimum-size
 *  rules. Returns a float — the caller formats it for the venue.
 *
 *  Cushion default of 0.005 (0.5%) reflects typical buy-side fee skim
 *  on Coinbase/Binance where fees are debited from the base side and
 *  the tracked `pos.volume` may exceed the real balance by ~0.1-0.6%. */
export function sellVolumeWithCushion(
  availableBase: number,
  cap: number,
  limits: VenueSellLimits | null,
  cushionPct: number = 0.005,
): number {
  if (!Number.isFinite(availableBase) || availableBase <= 0) return 0;
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const cushioned = Math.min(cap, availableBase * (1 - cushionPct));
  const min = limits?.baseMinSize ?? null;
  if (min != null && min > 0 && cushioned < min && availableBase >= min) {
    return Math.min(cap, availableBase);
  }
  return cushioned;
}

/** Return a human-readable blocker string if opening this buy would
 *  settle into a position below the venue's sell-side minimums. Null
 *  when safe. */
export function sellabilityBlocker(
  baseAmount: number,
  price: number,
  limits: VenueSellLimits | null,
): string | null {
  if (!limits) return null;
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return 'non-positive base amount';
  if (!Number.isFinite(price) || price <= 0) return 'non-positive price';
  const baseMin = limits.baseMinSize ?? 0;
  if (baseMin > 0 && baseAmount < baseMin) {
    return `post-fee base ${baseAmount.toFixed(8)} < venue min ${baseMin}`;
  }
  const notional = baseAmount * price;
  const notionalMin = Math.max(limits.quoteMinSize ?? 0, limits.minNotional ?? 0);
  if (notionalMin > 0 && notional < notionalMin) {
    return `post-fee notional $${notional.toFixed(2)} < venue min $${notionalMin}`;
  }
  return null;
}
