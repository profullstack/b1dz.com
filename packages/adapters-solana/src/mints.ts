/**
 * MVP Solana mint registry. Hardcoded addresses for v1 assets per PRD §28.2.
 * Mint is the SPL program ID for the token; it's analogous to an EVM
 * contract address but for the SPL token standard.
 */

export interface SolanaMint {
  symbol: string;
  mint: string;
  decimals: number;
  /** True for the native-SOL wrapped mint so callers can request "SOL" and
   *  the adapter substitutes WSOL under the hood. */
  wrapsNative?: boolean;
}

export const SOLANA_MINTS: Record<string, SolanaMint> = {
  SOL:  { symbol: 'SOL',  mint: 'So11111111111111111111111111111111111111112', decimals: 9, wrapsNative: true },
  USDC: { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDT: { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
};

export function mintFor(symbol: string): SolanaMint | null {
  const upper = symbol.toUpperCase();
  return SOLANA_MINTS[upper] ?? null;
}

export function toBaseUnits(amount: string, decimals: number): string {
  const [whole, frac = ''] = amount.split('.');
  const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const joined = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, '');
  return joined === '' ? '0' : joined;
}

export function fromBaseUnits(amount: string, decimals: number): string {
  const trimmed = amount.replace(/^0+/, '') || '0';
  if (decimals === 0) return trimmed;
  const padded = trimmed.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
