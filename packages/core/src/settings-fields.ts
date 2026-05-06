/**
 * Settings field catalog — single source of truth for everything a user
 * can configure via the web settings UI / CLI `b1dz setup`.
 *
 * **Why this lives in @b1dz/core**: both `apps/web` (which writes the
 * settings) and `apps/daemon` (which reads them via the per-tick env
 * overlay) need to know the list of keys. Previously the catalog lived
 * in `apps/web/src/lib/settings-fields.ts` and the daemon kept its own
 * hand-maintained `OVERLAY_KEYS` array — they drifted, and the result
 * was that user-saved settings like `BASE_RPC_URL` were stored in the
 * DB but never overlaid on `process.env` at tick time. Symptom: only
 * Gemini executed trades because every other adapter (Uniswap V3 on
 * Base, Jupiter on Solana, Pump.fun, the v2 triangular engine, etc.)
 * silently no-op'd when its required env wasn't visible.
 *
 * Adding a new user-facing setting: add it to one of the four arrays
 * below. The daemon's overlay automatically picks it up on next tick.
 *
 * The web layer encrypts/decrypts secrets client-side using the key
 * fetched from /api/settings/crypto-key. The server only stores
 * ciphertext for SECRET_FIELDS.
 */

export const SECRET_FIELDS = [
  // Coinbase
  'COINBASE_API_PRIVATE_KEY',
  'COINBASE_API_PRIVATE_KEY_B',
  'COINBASE_EC_KEY_B',
  // Kraken
  'KRAKEN_API_KEY',
  'KRAKEN_API_SECRET',
  // Binance.US
  'BINANCE_US_API_KEY',
  'BINANCE_US_API_SECRET',
  // Gemini
  'GEMINI_API_KEY',
  'GEMINI_API_SECRET',
  // DEX
  'ONEINCH_API_KEY',
  // Pump.fun data stream (pumpportal.fun)
  'PUMPPORTAL_API_KEY',
  // Hot wallets
  'EVM_PRIVATE_KEY',
  'SOLANA_PRIVATE_KEY',
  // Proxy creds
  'PROXY_USERNAME',
  'PROXY_PASSWORD',
] as const;

export type SecretField = typeof SECRET_FIELDS[number];

export const PLAIN_STRING_FIELDS = [
  // Coinbase has a non-secret key name alongside the private key
  'COINBASE_API_KEY_NAME',
  'GEMINI_ACCOUNT',
  // RPC endpoints
  'BASE_RPC_URL',
  'SOLANA_RPC_URL',
  // Wallet addresses (public)
  'EVM_WALLET_ADDRESS',
  'SOLANA_WALLET_ADDRESS',
  // Triangular config
  'ARB_TRIANGULAR_ANCHOR',
  'ARB_TRIANGULAR_TOKENS',
  'ARB_DEX_PAIRS',
  // Proxy URL
  'PROXY_URL',
  // Strategy modes
  'ARB_MODE',
  'V2_MODE',
  // DCA coin/exchange lists (comma-separated)
  'DCA_COINS',
  'DCA_EXCHANGES',
] as const;

export const PLAIN_NUMBER_FIELDS = [
  // Risk
  'DAILY_LOSS_LIMIT_PCT',
  'HARD_STOP_PCT',
  'TAKE_PROFIT_PCT',
  'MIN_NET_PROFIT_PCT',
  'ENTRY_MIN_SCORE',
  'MIN_HOLD_SECS',
  'MIN_VOLUME_USD',
  'MIN_PER_EXCHANGE_VOL_USD',
  'ROTATE_ADVERSE_PCT',
  'ROTATE_MIN_HOLD_MS',
  // Slippage
  'BUY_SLIPPAGE_BPS',
  'DEX_SLIPPAGE_BPS',
  'DEX_TRADE_BUDGET_USD',
  'DEX_TRADE_MAX_USD',
  // CEX arb
  'ARB_MAX_TRADE_USD',
  'ARB_SIZE_USD',
  'ARB_MIN_NET_USD',
  'ARB_MIN_NET_BPS',
  // DCA
  'DCA_TOTAL_ALLOCATION_PCT',
  'DCA_MAX_COINS',
  'DCA_INTERVAL_MS',
  // V2 pipeline
  'V2_SIZE_USD',
  'V2_MAX_PAIRS',
  'V2_MIN_NET_USD',
  'V2_MIN_NET_BPS',
  'V2_MAX_TRADE_USD',
  // Auto-seed
  'ARB_AUTO_SEED_MIN_USD',
  'ARB_AUTO_SEED_PER_PAIR_USD',
  'ARB_AUTO_SEED_GLOBAL_USD',
  'ARB_AUTO_SEED_PROFIT_RATIO',
  'ARB_AUTO_SEED_COOLDOWN_MS',
  'ARB_AUTO_SEED_EVAL_WINDOW_MS',
  'ARB_AUTO_SEED_PAUSE_MS',
  // Liquidator
  'ARB_LIQ_MAX_SLICE_USD',
  'ARB_LIQ_MIN_ASSET_USD',
  'ARB_LIQ_COOLDOWN_MS',
  // Triangular
  'ARB_TRIANGULAR_MIN_NET_USD',
  'ARB_TRIANGULAR_SIZE_USD',
  'ARB_TRIANGULAR_INTERVAL_MS',
  'ARB_TRIANGULAR_FEE_TIER',
  'ARB_TRIANGULAR_MAX_PER_TICK',
  // Pump.fun strategy
  'PUMPFUN_TRADE_SOL',
  'PUMPFUN_ENTRY_MIN_MCAP',
  'PUMPFUN_ENTRY_MAX_MCAP',
  'PUMPFUN_ENTRY_MAX_AGE_MIN',
  'PUMPFUN_ENTRY_MIN_AGE_MIN',
  'PUMPFUN_MAX_POSITIONS',
  'PUMPFUN_ENTRY_MIN_REPLIES',
  'PUMPFUN_ENTRY_MIN_SOL_RESERVES',
  'PUMPFUN_ENTRY_MIN_CURVE_PCT',
  'PUMPFUN_ENTRY_MAX_CURVE_PCT',
  'PUMPFUN_ENTRY_MIN_5M_PCT',
  'PUMPFUN_VOLUME_COLLAPSE_PCT',
  'PUMPFUN_PARTIAL_EXIT_PCT',
  'PUMPFUN_PARTIAL_EXIT_TRIGGER_PCT',
  'PUMPFUN_TAKE_PROFIT_PCT',
  'PUMPFUN_STOP_LOSS_PCT',
  'PUMPFUN_MAX_HOLD_MIN',
  'PUMPFUN_GRADUATION_CAP_USD',
  // Misc
  'ETH_USD_HINT',
  'GEMINI_NONCE_OFFSET',
] as const;

export const PLAIN_BOOL_FIELDS = [
  'ARB_TRIANGULAR',
  'DEX_TRADE_EXECUTION',
  'MARGIN_TRADING',
  'REQUIRE_CONFIRM_UPTREND',
  'ENABLE_PROXY',
  'DCA_ENABLED',
  'ARB_EXECUTOR_UNISWAP_BASE',
  'TRADING_ENABLED',
  'PUMPFUN_ENABLE_SCRAPE',
  'PUMPFUN_TRADE_EXECUTION',
] as const;

export type PlainStringField = typeof PLAIN_STRING_FIELDS[number];
export type PlainNumberField = typeof PLAIN_NUMBER_FIELDS[number];
export type PlainBoolField = typeof PLAIN_BOOL_FIELDS[number];

export const SECRET_SET = new Set<string>(SECRET_FIELDS);
export const PLAIN_STRING_SET = new Set<string>(PLAIN_STRING_FIELDS);
export const PLAIN_NUMBER_SET = new Set<string>(PLAIN_NUMBER_FIELDS);
export const PLAIN_BOOL_SET = new Set<string>(PLAIN_BOOL_FIELDS);

/** All keys the daemon should overlay onto process.env when running a
 *  per-user tick. Union of every catalog above. Iterating this list is
 *  how the daemon makes user_settings the actual source of truth at
 *  runtime — without it, settings written via the web UI sit in the DB
 *  but never affect adapter behavior. */
export const ALL_OVERLAY_KEYS: readonly string[] = [
  ...SECRET_FIELDS,
  ...PLAIN_STRING_FIELDS,
  ...PLAIN_NUMBER_FIELDS,
  ...PLAIN_BOOL_FIELDS,
];

export type PlainPayload = Partial<
  Record<PlainStringField, string | null>
  & Record<PlainNumberField, number | null>
  & Record<PlainBoolField, boolean | null>
>;

/**
 * Validate and coerce an incoming `plain` payload. Drops unknown keys.
 * Returns the cleaned object; never throws — invalid values are skipped.
 */
export function sanitizePlain(input: unknown): PlainPayload {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (PLAIN_STRING_SET.has(k)) {
      if (v === null || typeof v === 'string') out[k] = v;
    } else if (PLAIN_NUMBER_SET.has(k)) {
      if (v === null) out[k] = null;
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v);
    } else if (PLAIN_BOOL_SET.has(k)) {
      if (v === null || typeof v === 'boolean') out[k] = v;
    }
  }
  return out as PlainPayload;
}
