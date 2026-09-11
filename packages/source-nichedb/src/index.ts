/**
 * @b1dz/source-nichedb — read-only client for nichedb.dev's public items API
 * plus the two readers b1dz uses: the crypto universe (pair discovery) and
 * daily equity bars (strategy backtests). Everything real-time stays on the
 * venues' own feeds; this package only replaces slow-moving catalogue reads.
 */

export { nichedbEnabled, nichedbBaseUrl, DEFAULT_NICHEDB_URL, type NichedbSwitch } from './env.js';
export {
  createNichedbClient,
  NichedbError,
  NICHEDB_PAGE_LIMIT,
  type NichedbClient,
  type NichedbClientOptions,
  type NichedbItem,
  type ItemsQuery,
  type WalkOptions,
  type FetchLike,
} from './client.js';
export {
  CRYPTO_COLLECTION,
  DEFAULT_CRYPTO_VENUES,
  fetchCryptoPairs,
  fetchCryptoAssets,
  marketCapsBySymbol,
  selectCryptoPairs,
  type CryptoVenue,
  type CryptoAssetData,
  type CryptoPairData,
  type CryptoAssetItem,
  type CryptoPairItem,
  type CryptoSelectionRules,
  type CryptoSelection,
  type DiscoveredPair,
  type VenueListing,
} from './crypto.js';
export {
  MARKETS_COLLECTION,
  HISTORY_MAX_BARS,
  HISTORY_MAX_AGE_DAYS,
  historySymbolTag,
  dayToUtcMs,
  barsFromHistory,
  historyWindow,
  fetchHistoryItem,
  fetchDailyBars,
  type HistoryBarTuple,
  type HistoryData,
  type HistoryItem,
  type HistoryMiss,
  type HistoryResult,
  type HistoryOptions,
  type DailyBar,
} from './markets.js';
