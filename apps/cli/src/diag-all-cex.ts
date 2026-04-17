/**
 * b1dz diag-all-cex — one-shot auth check for all 4 CEXes.
 *
 * Prints each exchange's balance (or the error) so we can see which
 * auth is actually working in the current env. The trade-daemon's
 * silent `catch{}` hides failed auth — this script makes it loud.
 *
 * Usage: pnpm --filter @b1dz/cli exec tsx src/diag-all-cex.ts
 */
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env') });

const {
  getBalance: getKrakenBalance,
  getBinanceBalance,
  getCoinbaseBalance,
  getGeminiBalance,
} = await import('@b1dz/source-crypto-arb');

function envStatus(names: string[]): string {
  // Each entry may be a single name or "NAME_A|NAME_B" if either satisfies.
  return names.map((n) => {
    const alts = n.split('|');
    const hit = alts.find((alt) => process.env[alt]);
    return `${hit ?? alts[0]}=${hit ? '✓' : '✗'}`;
  }).join(' ');
}

function fmtBalance(bal: Record<string, string>): string {
  const entries = Object.entries(bal).filter(([, v]) => parseFloat(v) > 0.0001);
  if (entries.length === 0) return '(empty)';
  return entries.map(([k, v]) => `${k}=${parseFloat(v).toFixed(4)}`).join(' ');
}

async function probe(label: string, envVars: string[], fn: () => Promise<Record<string, string>>) {
  console.log(`── ${label} ──`);
  console.log(`  env:     ${envStatus(envVars)}`);
  try {
    const bal = await fn();
    console.log(`  balance: ${fmtBalance(bal)}`);
  } catch (e) {
    console.log(`  ✗ ${(e as Error).message}`);
  }
}

await probe('Kraken',     ['KRAKEN_API_KEY', 'KRAKEN_API_SECRET'], getKrakenBalance);
await probe('Coinbase',   ['COINBASE_API_KEY_NAME', 'COINBASE_API_PRIVATE_KEY|COINBASE_API_PRIVATE_KEY_B64'], getCoinbaseBalance);
await probe('Binance.US', ['BINANCE_US_API_KEY', 'BINANCE_US_API_SECRET'], getBinanceBalance);
await probe('Gemini',     ['GEMINI_API_KEY', 'GEMINI_API_SECRET'], getGeminiBalance);

console.log('');
console.log('If a row shows (empty) or ✗, the trade-daemon silently treats');
console.log('spendableQuoteBalances for that venue as $0 and will not enter');
console.log('new positions there — only Binance (or whoever has funds + auth).');
