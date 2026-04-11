/**
 * Canonical pair → exchange-specific symbol normalization.
 *
 * b1dz uses "BTC-USD" internally. Each exchange has its own naming:
 *   Gemini:     btcusd  (lowercase, no separator)
 *   Kraken:     XBTUSD  (XBT for BTC, uppercase)
 *   Binance.US: BTCUSD  (uppercase, no separator)
 */

const KRAKEN_BASES: Record<string, string> = {
  BTC: 'XBT',
};

export function normalizePair(canonical: string, exchange: string): string {
  const [base, quote] = canonical.split('-');
  const b = base.toUpperCase();
  const q = quote.toUpperCase();

  switch (exchange) {
    case 'gemini':
      return `${b}${q}`.toLowerCase();
    case 'kraken': {
      const kb = KRAKEN_BASES[b] ?? b;
      return `${kb}${q}`;
    }
    case 'binance-us':
      return `${b}${q}`;
    default:
      return `${b}${q}`;
  }
}
