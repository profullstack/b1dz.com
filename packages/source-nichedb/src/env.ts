/**
 * Feature switches for reading from nichedb.dev.
 *
 *   NICHEDB_CRYPTO=1   pair discovery reads the crypto universe from nichedb
 *   NICHEDB_MARKETS=1  strategy backtests read daily equity bars from nichedb
 *   NICHEDB_URL        base URL (default https://nichedb.dev)
 *
 * Read through `process.env[name]` on purpose: Next.js inlines
 * `process.env.NAME` member expressions at build time, and these are runtime
 * switches that must be flippable on the deployed daemon and web app.
 */

export type NichedbSwitch = 'NICHEDB_CRYPTO' | 'NICHEDB_MARKETS';

const ON = new Set(['1', 'true', 'yes', 'on']);

export function nichedbEnabled(name: NichedbSwitch, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name];
  if (raw == null) return false;
  return ON.has(raw.trim().toLowerCase());
}

export const DEFAULT_NICHEDB_URL = 'https://nichedb.dev';

export function nichedbBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['NICHEDB_URL']?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_NICHEDB_URL).replace(/\/+$/, '');
}
