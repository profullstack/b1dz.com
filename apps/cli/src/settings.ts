/**
 * `b1dz settings` — read-only print of /api/settings.
 *
 * Fetches the encryption key from /api/settings/crypto-key and decrypts the
 * cipher blob locally to determine which secrets are set (without printing
 * any values). Editing happens at https://b1dz.com/settings or via
 * `b1dz setup`.
 */
import { loadCredentials } from './auth.js';
import { fetchCryptoKey, decryptJson, type CipherBlob } from './crypto-key.js';

interface SettingsResponse {
  plain: Record<string, string | number | boolean | null | undefined>;
  cipher: CipherBlob | null;
  lastUpdatedAt: string | null;
  cryptoConfigured: boolean;
}

const SECRET_FIELDS = [
  ['CEX', [
    'COINBASE_API_PRIVATE_KEY', 'COINBASE_API_PRIVATE_KEY_B', 'COINBASE_EC_KEY_B',
    'KRAKEN_API_KEY', 'KRAKEN_API_SECRET',
    'BINANCE_US_API_KEY', 'BINANCE_US_API_SECRET',
    'GEMINI_API_KEY', 'GEMINI_API_SECRET',
  ]],
  ['DEX', ['ONEINCH_API_KEY', 'EVM_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY']],
] as const;

const PLAIN_GROUPS: { name: string; fields: string[] }[] = [
  { name: 'Wallets', fields: ['EVM_WALLET_ADDRESS', 'SOLANA_WALLET_ADDRESS'] },
  { name: 'Account labels', fields: ['COINBASE_API_KEY_NAME', 'GEMINI_ACCOUNT'] },
  { name: 'RPC URLs', fields: ['BASE_RPC_URL', 'SOLANA_RPC_URL'] },
  { name: 'Risk', fields: [
    'DAILY_LOSS_LIMIT_PCT', 'HARD_STOP_PCT', 'TAKE_PROFIT_PCT', 'ENTRY_MIN_SCORE',
    'MIN_HOLD_SECS', 'MIN_VOLUME_USD', 'MIN_PER_EXCHANGE_VOL_USD',
    'ROTATE_ADVERSE_PCT', 'ROTATE_MIN_HOLD_MS',
  ] },
  { name: 'Slippage / budget', fields: ['BUY_SLIPPAGE_BPS', 'DEX_SLIPPAGE_BPS', 'DEX_TRADE_BUDGET_USD'] },
  { name: 'Auto-seed', fields: [
    'ARB_AUTO_SEED_MIN_USD', 'ARB_AUTO_SEED_PER_PAIR_USD', 'ARB_AUTO_SEED_GLOBAL_USD',
    'ARB_AUTO_SEED_PROFIT_RATIO', 'ARB_AUTO_SEED_COOLDOWN_MS',
    'ARB_AUTO_SEED_EVAL_WINDOW_MS', 'ARB_AUTO_SEED_PAUSE_MS',
  ] },
  { name: 'Liquidator', fields: ['ARB_LIQ_MAX_SLICE_USD', 'ARB_LIQ_MIN_ASSET_USD', 'ARB_LIQ_COOLDOWN_MS'] },
  { name: 'Triangular', fields: [
    'ARB_TRIANGULAR_MIN_NET_USD', 'ARB_TRIANGULAR_SIZE_USD', 'ARB_TRIANGULAR_INTERVAL_MS',
    'ARB_TRIANGULAR_FEE_TIER', 'ARB_TRIANGULAR_MAX_PER_TICK', 'ARB_TRIANGULAR_ANCHOR',
    'ARB_TRIANGULAR_TOKENS',
  ] },
  { name: 'Misc', fields: ['ETH_USD_HINT', 'GEMINI_NONCE_OFFSET', 'ARB_DEX_PAIRS'] },
  { name: 'Toggles', fields: [
    'ARB_TRIANGULAR', 'DEX_TRADE_EXECUTION', 'MARGIN_TRADING',
    'REQUIRE_CONFIRM_UPTREND', 'ENABLE_PROXY',
  ] },
];

function apiBaseUrl(): string {
  const url = process.env.B1DZ_API_URL;
  if (!url) throw new Error('B1DZ_API_URL missing in .env');
  return url;
}

function fmtPlain(v: unknown): string {
  if (v === null || v === undefined || v === '') return '\x1b[2munset\x1b[0m';
  if (typeof v === 'boolean') return v ? '\x1b[32mtrue\x1b[0m' : '\x1b[31mfalse\x1b[0m';
  return String(v);
}

function fmtSecret(plaintext: string | undefined): string {
  if (!plaintext) return '\x1b[2munset\x1b[0m';
  return `\x1b[32mset\x1b[0m (\x1b[2m${plaintext.length} chars\x1b[0m)`;
}

export async function settings() {
  const c = loadCredentials();
  if (!c) {
    console.error('not signed in — run `b1dz login` first');
    process.exit(1);
  }
  const baseUrl = apiBaseUrl();
  const res = await fetch(`${baseUrl}/api/settings`, {
    headers: { authorization: `Bearer ${c.accessToken}` },
  });
  if (!res.ok) {
    console.error(`settings fetch failed: ${res.status}`);
    process.exit(1);
  }
  const data = await res.json() as SettingsResponse;

  // Decrypt the cipher locally to know which secrets are set (without
  // printing values).
  let decrypted: Record<string, string> = {};
  if (data.cipher && data.cryptoConfigured) {
    try {
      const keyB64 = await fetchCryptoKey(baseUrl, c.accessToken);
      decrypted = decryptJson<Record<string, string>>(keyB64, data.cipher);
    } catch (e) {
      console.log(`\x1b[33m⚠ could not decrypt secrets: ${(e as Error).message}\x1b[0m`);
    }
  }

  console.log(`\n\x1b[1msigned in as\x1b[0m ${c.email}`);
  console.log(`\x1b[2muser_id: ${c.userId}\x1b[0m`);
  console.log(`\x1b[2mlast updated: ${data.lastUpdatedAt ?? 'never'}\x1b[0m`);
  if (!data.cryptoConfigured) {
    console.log('\x1b[33m⚠ server-side encryption key not configured; secret writes are blocked\x1b[0m');
  }

  for (const group of PLAIN_GROUPS) {
    console.log(`\n\x1b[1m${group.name}\x1b[0m`);
    for (const f of group.fields) {
      console.log(`  ${f.padEnd(34)} ${fmtPlain(data.plain[f])}`);
    }
  }

  for (const [groupName, fields] of SECRET_FIELDS) {
    console.log(`\n\x1b[1m${groupName} secrets\x1b[0m`);
    for (const f of fields) {
      console.log(`  ${f.padEnd(34)} ${fmtSecret(decrypted[f])}`);
    }
  }

  console.log(`\n\x1b[36mManage at: https://b1dz.com/settings\x1b[0m\n`);
}
