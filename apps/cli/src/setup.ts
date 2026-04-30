/**
 * `b1dz setup [section]` — guided interactive walkthrough that prompts for
 * keys/values and PUTs them to /api/settings. Plaintext entered here travels
 * over HTTPS to the server, which encrypts before storing. The server never
 * stores plaintext at rest and never returns plaintext on read.
 *
 * Run with no arg for the full guided tour. Run with a section name
 * (`coinbase`, `kraken`, `binance`, `gemini`, `oneinch`, `evm`, `solana`,
 * `wallets`, `thresholds`, `toggles`) to jump to one section.
 */
import { createInterface } from 'node:readline/promises';
import { loadCredentials, promptPassword } from './auth.js';

function apiBaseUrl(): string {
  const url = process.env.B1DZ_API_URL;
  if (!url) throw new Error('B1DZ_API_URL missing in .env');
  return url;
}

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

interface MaskedSecret { set: boolean; length?: number }
interface SettingsResponse {
  plain: Record<string, string | number | boolean | null | undefined>;
  secret: Record<string, MaskedSecret>;
  lastUpdatedAt: string | null;
  cryptoConfigured: boolean;
}

interface ApiCtx {
  accessToken: string;
  baseUrl: string;
}

async function fetchSettings(ctx: ApiCtx): Promise<SettingsResponse> {
  const res = await fetch(`${ctx.baseUrl}/api/settings`, {
    headers: { authorization: `Bearer ${ctx.accessToken}` },
  });
  if (!res.ok) throw new Error(`fetch settings: ${res.status}`);
  return (await res.json()) as SettingsResponse;
}

async function saveSettings(ctx: ApiCtx, body: { plain?: Record<string, string | null>; secret?: Record<string, string | null> }): Promise<SettingsResponse> {
  const res = await fetch(`${ctx.baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ctx.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`save: ${res.status} ${t.slice(0, 200)}`);
  }
  return (await res.json()) as SettingsResponse;
}

async function ask(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(label);
  rl.close();
  return ans.trim();
}

/** Prompt for a value. Empty = skip (keep current). 'clear' = set to null. */
async function promptField(label: string, current: string, secret: boolean): Promise<string | null | 'skip'> {
  const hint = current
    ? C.dim(`  current: ${secret ? `set (${current})` : current}  ${C.dim('(enter to skip, "clear" to remove)')}`)
    : C.dim(`  unset  ${C.dim('(enter to skip)')}`);
  console.log(hint);
  const value = secret
    ? await promptPassword(`  ${label}: `)
    : await ask(`  ${label}: `);
  if (value === '') return 'skip';
  if (value === 'clear') return null;
  return value;
}

function maskedSummary(masked: MaskedSecret | undefined): string {
  if (!masked?.set) return 'unset';
  return `set (${masked.length ?? '?'} chars)`;
}

function plainSummary(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'unset';
  return String(v);
}

interface SecretFieldSpec {
  key: string;
  label: string;
}

interface PlainFieldSpec {
  key: string;
  label: string;
  hint?: string;
  type?: 'string' | 'number' | 'bool';
}

interface Section {
  id: string;
  title: string;
  intro: string;
  url?: string;
  plain?: PlainFieldSpec[];
  secret?: SecretFieldSpec[];
}

const SECTIONS: Section[] = [
  {
    id: 'coinbase',
    title: 'Coinbase Advanced Trade',
    intro: 'API key + private key (PEM). Required scopes: View, Trade. Cloud key format.',
    url: 'https://www.coinbase.com/settings/api',
    plain: [{ key: 'COINBASE_API_KEY_NAME', label: 'API key name (organizations/.../apiKeys/...)' }],
    secret: [
      { key: 'COINBASE_API_PRIVATE_KEY', label: 'Private key (paste full -----BEGIN EC PRIVATE KEY----- block, end with blank line)' },
      { key: 'COINBASE_API_PRIVATE_KEY_B', label: 'Secondary private key (optional, enter to skip)' },
      { key: 'COINBASE_EC_KEY_B', label: 'Secondary EC key (optional)' },
    ],
  },
  {
    id: 'kraken',
    title: 'Kraken',
    intro: 'API key + secret. Required scopes: Query Funds, Query Open Orders, Query Closed Orders, Query Ledger Entries, Create & Modify Orders, Cancel Orders.',
    url: 'https://www.kraken.com/u/security/api',
    secret: [
      { key: 'KRAKEN_API_KEY', label: 'API key' },
      { key: 'KRAKEN_API_SECRET', label: 'API secret (private key, base64)' },
    ],
  },
  {
    id: 'binance',
    title: 'Binance.US',
    intro: 'API key + secret. Enable Spot Trading. IP-restrict if you have a static egress.',
    url: 'https://accounts.binance.us/en/account/api-management',
    secret: [
      { key: 'BINANCE_US_API_KEY', label: 'API key' },
      { key: 'BINANCE_US_API_SECRET', label: 'API secret' },
    ],
  },
  {
    id: 'gemini',
    title: 'Gemini',
    intro: 'API key + secret. Role: Trader (or Auditor for read-only). Master/sub-account toggle below.',
    url: 'https://exchange.gemini.com/settings/api',
    plain: [
      { key: 'GEMINI_ACCOUNT', label: 'Account name', hint: 'primary | master | <subaccount label>' },
      { key: 'GEMINI_NONCE_OFFSET', label: 'Nonce offset', hint: 'leave blank unless reusing a key from another client', type: 'number' },
    ],
    secret: [
      { key: 'GEMINI_API_KEY', label: 'API key' },
      { key: 'GEMINI_API_SECRET', label: 'API secret' },
    ],
  },
  {
    id: 'oneinch',
    title: '1inch',
    intro: 'API key for 1inch quote/swap router (DEX aggregation across EVM chains).',
    url: 'https://portal.1inch.dev/',
    secret: [{ key: 'ONEINCH_API_KEY', label: 'API key' }],
  },
  {
    id: 'evm',
    title: 'EVM hot wallet',
    intro: 'Private key for the wallet that signs Uniswap-V3 / 1inch / Aerodrome swaps on Base + Ethereum. Use a dedicated low-balance wallet.',
    url: 'Export from MetaMask: Account → ⋮ → Account details → Show private key',
    plain: [{ key: 'EVM_WALLET_ADDRESS', label: 'Wallet address (0x…)', hint: 'Public — for display only. Not used to sign.' }],
    secret: [{ key: 'EVM_PRIVATE_KEY', label: '0x… 64-hex private key' }],
  },
  {
    id: 'solana',
    title: 'Solana hot wallet',
    intro: 'Private key for Jupiter / pump.fun signing. Dedicated low-balance wallet recommended.',
    url: 'Export from Phantom: ⚙ Settings → Manage Accounts → Show Private Key',
    plain: [{ key: 'SOLANA_WALLET_ADDRESS', label: 'Wallet address (base58)', hint: 'Public — for display only.' }],
    secret: [{ key: 'SOLANA_PRIVATE_KEY', label: 'Base58 secret key (88 chars) or JSON array' }],
  },
  {
    id: 'thresholds',
    title: 'Thresholds & defaults',
    intro: 'Per-account overrides for trade-engine knobs. Leave blank to use the system defaults from .env.',
    plain: [
      { key: 'DAILY_LOSS_LIMIT_PCT', label: 'Daily loss limit %', hint: 'default 5.0', type: 'number' },
      { key: 'DEX_TRADE_BUDGET_USD', label: 'DEX trade budget USD', hint: 'max $ per single DEX swap', type: 'number' },
      { key: 'DEX_SLIPPAGE_BPS', label: 'DEX slippage bps', hint: 'default 300 (= 3%)', type: 'number' },
    ],
  },
  {
    id: 'toggles',
    title: 'Trading toggles',
    intro: 'On/off switches. Type "true" / "false" / "clear" / blank to skip.',
    plain: [
      { key: 'DEX_TRADE_EXECUTION', label: 'DEX execution armed?', type: 'bool' },
      { key: 'MARGIN_TRADING', label: 'Margin trading?', type: 'bool' },
    ],
  },
];

async function runSection(ctx: ApiCtx, current: SettingsResponse, section: Section): Promise<SettingsResponse> {
  console.log(`\n${C.bold(section.title)}`);
  console.log(`  ${section.intro}`);
  if (section.url) console.log(`  ${C.cyan(section.url)}`);
  console.log();

  const plainBody: Record<string, string | null> = {};
  const secretBody: Record<string, string | null> = {};

  for (const spec of section.plain ?? []) {
    const cur = plainSummary(current.plain[spec.key]);
    if (spec.hint) console.log(C.dim(`  ${spec.hint}`));
    const value = await promptField(`${spec.label} ${C.dim(`[${spec.key}]`)}`, cur === 'unset' ? '' : cur, false);
    if (value === 'skip') continue;
    if (value === null) plainBody[spec.key] = null;
    else if (spec.type === 'bool') {
      const b = value.toLowerCase();
      if (b === 'true' || b === 'yes' || b === '1' || b === 'on') plainBody[spec.key] = 'true';
      else if (b === 'false' || b === 'no' || b === '0' || b === 'off') plainBody[spec.key] = 'false';
      else { console.log(C.red(`  ✗ couldn't parse "${value}" as boolean — skipped`)); }
    } else {
      plainBody[spec.key] = value;
    }
  }

  for (const spec of section.secret ?? []) {
    const cur = maskedSummary(current.secret[spec.key]);
    const value = await promptField(`${spec.label} ${C.dim(`[${spec.key}]`)}`, cur === 'unset' ? '' : cur, true);
    if (value === 'skip') continue;
    secretBody[spec.key] = value;
  }

  if (Object.keys(plainBody).length === 0 && Object.keys(secretBody).length === 0) {
    console.log(C.dim('  (no changes)'));
    return current;
  }

  console.log();
  const summary = [
    ...Object.entries(plainBody).map(([k, v]) => `  ${k} = ${v === null ? C.red('clear') : v}`),
    ...Object.entries(secretBody).map(([k, v]) => `  ${k} = ${v === null ? C.red('clear') : C.green(`${(v as string).length} chars`)}`),
  ].join('\n');
  console.log(C.bold('Pending changes:'));
  console.log(summary);
  const confirm = (await ask(`\nSave ${section.title}? [Y/n] `)).toLowerCase();
  if (confirm === 'n' || confirm === 'no') {
    console.log(C.dim('  skipped — nothing saved'));
    return current;
  }

  try {
    const next = await saveSettings(ctx, { plain: plainBody, secret: secretBody });
    console.log(C.green(`  ✓ saved ${Object.keys(plainBody).length} plain + ${Object.keys(secretBody).length} secret fields`));
    return next;
  } catch (e) {
    console.log(C.red(`  ✗ ${(e as Error).message}`));
    return current;
  }
}

export async function setup(args: string[]) {
  const c = loadCredentials();
  if (!c) {
    console.error(C.red('not signed in — run `b1dz login` first'));
    process.exit(1);
  }
  const ctx: ApiCtx = { accessToken: c.accessToken, baseUrl: apiBaseUrl() };

  let current: SettingsResponse;
  try {
    current = await fetchSettings(ctx);
  } catch (e) {
    console.error(C.red(`could not fetch settings: ${(e as Error).message}`));
    process.exit(1);
  }

  if (!current.cryptoConfigured) {
    console.log(C.yellow('⚠ server-side SETTINGS_ENCRYPTION_KEY is not configured — secret saves will be blocked.\n  Ask the operator to set it on Railway, then retry.'));
  }

  const wanted = args[0]?.toLowerCase();
  const sections = wanted
    ? SECTIONS.filter((s) => s.id === wanted)
    : SECTIONS;

  if (wanted && sections.length === 0) {
    console.error(C.red(`unknown section "${wanted}". valid: ${SECTIONS.map((s) => s.id).join(', ')}`));
    process.exit(1);
  }

  console.log(`\n${C.bold('b1dz setup')}  ${C.dim(`signed in as ${c.email}`)}`);
  console.log(C.dim('Plaintext you enter is sent to the server over HTTPS, encrypted with AES-256-GCM at rest, and never returned to the browser. Press enter to skip a field. Type "clear" to remove an existing value.'));

  for (const s of sections) {
    current = await runSection(ctx, current, s);
  }

  console.log(`\n${C.green('Setup complete.')}  Verify anytime with ${C.cyan('b1dz settings')}.\n`);
}
