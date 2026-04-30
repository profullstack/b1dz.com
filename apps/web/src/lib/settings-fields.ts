/**
 * Settings field catalog.
 *
 * Phase A only stores values; Phase B will wire the daemon to read these
 * keys from user_settings instead of process.env. The names here MUST match
 * the existing env-var names so Phase B is a mechanical swap.
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
] as const;

export const PLAIN_NUMBER_FIELDS = [
  // Risk
  'DAILY_LOSS_LIMIT_PCT',
  'HARD_STOP_PCT',
  'TAKE_PROFIT_PCT',
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
] as const;

export type PlainStringField = typeof PLAIN_STRING_FIELDS[number];
export type PlainNumberField = typeof PLAIN_NUMBER_FIELDS[number];
export type PlainBoolField = typeof PLAIN_BOOL_FIELDS[number];

export const SECRET_SET = new Set<string>(SECRET_FIELDS);
export const PLAIN_STRING_SET = new Set<string>(PLAIN_STRING_FIELDS);
export const PLAIN_NUMBER_SET = new Set<string>(PLAIN_NUMBER_FIELDS);
export const PLAIN_BOOL_SET = new Set<string>(PLAIN_BOOL_FIELDS);

export type PlainPayload = Partial<
  Record<PlainStringField, string | null>
  & Record<PlainNumberField, number | null>
  & Record<PlainBoolField, boolean | null>
>;

export type SecretPayload = Partial<Record<SecretField, string | null>>;

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

/**
 * Validate an incoming `secret` payload. Each value must be a string OR null
 * (null means "delete this field"). Drops unknown keys silently.
 */
export function sanitizeSecret(input: unknown): SecretPayload {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!SECRET_SET.has(k)) continue;
    if (v === null) out[k] = null;
    else if (typeof v === 'string') out[k] = v;
  }
  return out as SecretPayload;
}

export type MaskedSecret = { set: false } | { set: true; length: number };

export function maskSecrets(secret: SecretPayload): Record<string, MaskedSecret> {
  const out: Record<string, MaskedSecret> = {};
  for (const f of SECRET_FIELDS) {
    const v = secret[f];
    out[f] = typeof v === 'string' && v.length > 0 ? { set: true, length: v.length } : { set: false };
  }
  return out;
}
