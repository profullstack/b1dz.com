/**
 * Canonical trading-cost constants.
 *
 * These live in @b1dz/core (which everything depends on) so the backtester, the
 * observer, the profitability ranker, and the live daemon all price a fill the
 * same way. A strategy that looks profitable in a backtest priced at 0 bps and
 * loses money live at 26 bps is the single most common way a systematic trading
 * system fails — so there is exactly ONE table and everybody reads it.
 *
 * Rates are decimal fractions of notional (0.0026 = 26 bps = 0.26%), matching
 * the wire format every exchange API uses.
 */

/**
 * Taker fee per fill, by CEX venue id. Taker (not maker) because every path in
 * b1dz that crosses the spread — market orders, IOC limits, arb legs — pays the
 * taker side. Sourced from each venue's published retail schedule; volume tiers
 * and fee-token discounts only ever make the real number smaller, so using the
 * top-tier rate keeps estimates conservative.
 */
export const CEX_TAKER_FEE_RATES: Record<string, number> = {
  kraken: 0.0026,
  'binance-us': 0.001,
  coinbase: 0.006,
  gemini: 0.004,
};

/** Fallback for an unrecognized CEX — deliberately worse than any known venue. */
export const DEFAULT_CEX_TAKER_FEE = 0.005;

/**
 * Typical AMM pool fee for the DEX venues b1dz routes through (Uniswap V3 0.30%
 * tier, 1inch/0x aggregated routes land in the same neighbourhood). Gas is a
 * separate, flat per-transaction cost — see `DEFAULT_DEX_GAS_USD`.
 */
export const DEFAULT_DEX_POOL_FEE = 0.003;

/**
 * Rough per-swap gas cost on an L2 (Base). A placeholder for estimation only:
 * live paths must use a real gas quote from @b1dz/adapters-evm, never this.
 */
export const DEFAULT_DEX_GAS_USD = 0.15;

/**
 * US equity retail commission. Zero at every broker b1dz connects to (Alpaca,
 * Schwab, Tradier, TradeStation, Webull, IBKR Lite).
 *
 * Not modelled here because they round to noise at retail size: the SEC Section
 * 31 fee and FINRA TAF apply to SELLS only and together come to well under
 * 1 bp. Treat equity commissions as zero and let spread + slippage carry the
 * cost estimate.
 */
export const DEFAULT_EQUITY_COMMISSION = 0;

/** Taker fee for a venue id, falling back to the conservative default. */
export function cexTakerFee(venue: string): number {
  return CEX_TAKER_FEE_RATES[venue] ?? DEFAULT_CEX_TAKER_FEE;
}

/** Decimal fraction → basis points (0.0026 → 26). */
export function toBps(rate: number): number {
  return rate * 10_000;
}

/** Basis points → decimal fraction (26 → 0.0026). */
export function fromBps(bps: number): number {
  return bps / 10_000;
}
