/**
 * Which research cards an agent pays for (b1dz monetization plan, 2026-11-25).
 *
 * The rule from the plan: meter ONLY derived analytics, FRED/EIA data and AI
 * synthesis. NEVER meter or resell raw quotes (Alpaca IEX via NicheDB, Yahoo,
 * Nasdaq, exchange public APIs, Coinbase Derivatives, ...): those cards stay
 * free and unmetered for everyone. People at /terminal never pay per card;
 * this only decides what an agent (API token, MCP, x402) is charged.
 *
 * Classification is explicit and lives in this one file:
 *   - a card whose source is FRED or EIA is metered ('fred' / 'eia');
 *   - a card listed in DERIVED_CARDS is metered ('derived'): b1dz computes it
 *     (ratios, risk statistics, dealer gamma, a bond price), so what it returns
 *     is analysis, not a quote;
 *   - everything else is free, raw quote cards above all. A card whose source
 *     is a raw quote provider can only be metered by being listed as derived,
 *     and billing.test.ts fails if a quote card (chart, board, chain, book,
 *     price history...) ever is.
 */
import type { CardDef } from './types.js';

export type MeterBasis = 'derived' | 'fred' | 'eia';

export interface CardBilling {
  metered: boolean;
  /** Why it is metered. Absent for free cards. */
  basis?: MeterBasis;
  /** True when the card's data comes from a raw quote provider (never resold). */
  rawQuotes: boolean;
}

/**
 * Sources that serve market quotes. A card from one of these is a raw-quote
 * card unless it is in DERIVED_CARDS (b1dz computes something new from the
 * inputs and shows that, not the quotes).
 */
export const RAW_QUOTE_SOURCES: readonly string[] = [
  'Nasdaq',
  'Nasdaq Nordic',
  'Market data', // Yahoo / Coinbase Derivatives fallback chain
  'Cboe',
  'TMX Money',
  'Coinbase',
  'Kraken',
  'Kraken Futures',
  'Exchange public APIs',
  'OKX',
  'Hyperliquid',
  'Deribit',
  'CoinPaprika',
  'CoinGecko',
];

/** Pattern form of the same, for sources that combine several labels. */
export const RAW_QUOTE_PATTERN = /\b(nasdaq|market data|yahoo|alpaca|iex|nichedb markets|cboe|tmx|coinbase|kraken|binance|gemini|exchange|okx|hyperliquid|deribit|bybit|bitmex|coinpaprika|coingecko|stooq|cme)\b/i;

/**
 * Derived analytics: b1dz computes these. Each entry says what is derived.
 * Add a card here only if its output is a computation, never a quote table.
 */
export const DERIVED_CARDS: Readonly<Record<string, string>> = {
  'equities.roic': 'return on invested capital computed from statements',
  'equities.dupont': 'DuPont decomposition of ROE',
  'equities.risk-peers': 'beta, volatility and drawdown versus peers',
  'equities.valuation-history': 'valuation multiples computed from filings and prices',
  'equities.surprise-history': 'EPS surprise computed from filings',
  'equities.etf-overlap': 'holdings overlap between two funds',
  'equities.factor-board': 'factor returns computed from ETF baskets',
  'equities.style-box': 'style box returns computed from ETF baskets',
  'equities.correlations': 'cross-asset correlation matrix',
  'equities.risk-stats': 'volatility, drawdown and Sharpe statistics',
  'equities.rotation': 'relative rotation (RS-ratio and momentum)',
  'derivatives.options-gamma': 'dealer gamma exposure and max pain',
  'derivatives.options-vol-cone': 'realised volatility cone versus implied',
  'derivatives.options-payoff': 'strategy payoff at expiry',
  'credit.bond-pricer': 'bond price, yield, duration and convexity',
  'credit.maturity-wall': 'debt maturity schedule built from filings',
  'fx.strength': 'currency strength index computed from reference rates',
  'fx.pair-differential': 'pair versus its policy-rate differential',
  'rates.curve-changes': 'yield curve changes by tenor',
};

export function isRawQuoteSource(source: string): boolean {
  return RAW_QUOTE_SOURCES.includes(source) || RAW_QUOTE_PATTERN.test(source);
}

export function cardBilling(card: Pick<CardDef, 'id' | 'source'>): CardBilling {
  const rawQuotes = isRawQuoteSource(card.source);
  if (DERIVED_CARDS[card.id]) return { metered: true, basis: 'derived', rawQuotes };
  if (!rawQuotes && /^FRED\b/.test(card.source)) return { metered: true, basis: 'fred', rawQuotes };
  if (!rawQuotes && /^EIA\b/.test(card.source)) return { metered: true, basis: 'eia', rawQuotes };
  return { metered: false, rawQuotes };
}
