/**
 * The trade universe: which pairs the crypto-trade worker is allowed to
 * open positions in, and which entry setups count as momentum.
 *
 * Pair discovery (getActivePairs) admits anything over a $10M market cap
 * listed on two venues, which is hundreds of small caps and meme coins.
 * Fast pumps on thin books are exactly where a momentum bot buys the top
 * and stops out, so new entries are restricted to a short list of large,
 * liquid, non-meme assets.
 *
 *   TRADE_UNIVERSE   comma list of bases (BTC,ETH,...) replacing the
 *                    default list. `all` disables the allowlist (the
 *                    meme/stable blocklist still applies).
 *   MOMENTUM_ONLY    default true: the built-in strategy only enters on
 *                    trend-continuation and breakout setups.
 */

import type { AnalysisSignal, SetupType } from './analysis/engine.js';

/** Large-cap, liquid, non-meme, non-stable assets that trade USD on the
 *  US venues we use (Kraken, Coinbase, Binance.US, Gemini). */
export const DEFAULT_TRADE_UNIVERSE: readonly string[] = [
  'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC',
  'BCH', 'XLM', 'HBAR', 'SUI', 'NEAR', 'UNI', 'AAVE', 'ATOM',
];

/** Never traded, even when named in TRADE_UNIVERSE: meme coins (pump and
 *  dump magnets), stablecoins and fiat (no momentum to trade), and wrapped
 *  or staked derivatives (duplicate exposure, thinner books). */
export const BLOCKED_BASES: ReadonlySet<string> = new Set([
  // meme coins
  'DOGE', 'SHIB', 'PEPE', 'BONK', 'WIF', 'FLOKI', 'TRUMP', 'MELANIA', 'POPCAT',
  'MEW', 'BOME', 'FARTCOIN', 'PNUT', 'GOAT', 'MOODENG', 'SPX', 'TURBO', 'BRETT',
  'NEIRO', 'MOG', 'DEGEN', 'PENGU', 'AI16Z', 'BABYDOGE', 'WOJAK', 'LADYS',
  'MYRO', 'SLERF', 'TOSHI', 'PONKE', 'CHILLGUY', 'GIGA', 'DOGS', 'NOT', 'HMSTR',
  'CAT', 'BAN', 'ACT', 'MEME', 'COQ', 'ELON', 'KISHU', 'SAMO', 'WEN', 'MICHI',
  // stablecoins and fiat
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP', 'GUSD', 'PYUSD', 'FDUSD', 'USDE',
  'USDS', 'RLUSD', 'EURC', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY',
  // wrapped / staked derivatives
  'WBTC', 'WETH', 'STETH', 'WSTETH', 'CBETH', 'RETH', 'CBBTC', 'MSOL', 'JITOSOL',
]);

export function baseOf(pair: string): string {
  return pair.toUpperCase().split(/[-/]/)[0] ?? '';
}

let cache: { raw: string | undefined; universe: ReadonlySet<string> | null } | null = null;

/** The allowlist in force, or null when TRADE_UNIVERSE=all. */
export function tradeUniverse(): ReadonlySet<string> | null {
  const raw = process.env.TRADE_UNIVERSE?.trim();
  if (cache && cache.raw === raw) return cache.universe;
  let universe: ReadonlySet<string> | null;
  if (raw && raw.toLowerCase() === 'all') {
    universe = null;
  } else {
    const list = raw ? raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
    universe = new Set(list.length > 0 ? list : DEFAULT_TRADE_UNIVERSE);
  }
  cache = { raw, universe };
  return universe;
}

/** True when new positions may be opened in this pair. */
export function isTradablePair(pair: string): boolean {
  const base = baseOf(pair);
  if (!base || BLOCKED_BASES.has(base)) return false;
  const universe = tradeUniverse();
  return universe === null || universe.has(base);
}

/**
 * The pairs to scan this tick: discovered pairs inside the universe, plus
 * any pair we still hold so trailing stops and exits keep running on
 * positions opened before the universe was narrowed.
 */
export function scanPairs(discovered: readonly string[], heldPairs: Iterable<string>): string[] {
  const out = new Set(discovered.filter(isTradablePair));
  for (const p of heldPairs) out.add(p);
  return [...out];
}

/** Long setups that count as momentum: riding an established trend or a
 *  confirmed breakout. Mean reversion (buying a falling price) is not. */
export const MOMENTUM_SETUPS: ReadonlySet<SetupType> = new Set<SetupType>(['long_trend_continuation', 'breakout']);

export function momentumOnlyFromEnv(): boolean {
  return (process.env.MOMENTUM_ONLY ?? 'true').toLowerCase() !== 'false';
}

export function isMomentumEntry(analysis: AnalysisSignal | null): boolean {
  return !!analysis
    && !analysis.rejected
    && analysis.direction === 'long'
    && analysis.setupType !== null
    && MOMENTUM_SETUPS.has(analysis.setupType);
}
