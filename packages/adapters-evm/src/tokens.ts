/**
 * Minimal token registry for MVP assets across supported EVM chains.
 *
 * This is intentionally hardcoded rather than fetched from a token list —
 * only the v1 scope needs to work (USDC, USDT, DAI, WETH, WBTC), and
 * trusting a remote token list opens us to listing spam. Expand when the
 * token-registry package lands.
 */

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  /** Normalizes wrappers so callers can say "ETH" without caring about WETH. */
  wrapsNative?: boolean;
}

export type EvmChain = 'ethereum' | 'base' | 'avalanche' | 'arbitrum' | 'optimism' | 'polygon';

export const EVM_CHAIN_IDS: Record<EvmChain, number> = {
  ethereum: 1,
  base: 8453,
  avalanche: 43114,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

/** Native-asset sentinel used by 0x and most aggregators for ETH / AVAX / POL. */
export const NATIVE_ASSET_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export const TOKENS: Record<EvmChain, Record<string, TokenInfo>> = {
  ethereum: {
    ETH:  { symbol: 'ETH',  address: NATIVE_ASSET_SENTINEL, decimals: 18 },
    WETH: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, wrapsNative: true },
    USDC: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    USDT: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    DAI:  { symbol: 'DAI',  address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    WBTC: { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
  },
  base: {
    ETH:   { symbol: 'ETH',   address: NATIVE_ASSET_SENTINEL, decimals: 18 },
    WETH:  { symbol: 'WETH',  address: '0x4200000000000000000000000000000000000006', decimals: 18, wrapsNative: true },
    USDC:  { symbol: 'USDC',  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    USDbC: { symbol: 'USDbC', address: '0xd9AAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6 },
    DAI:   { symbol: 'DAI',   address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    cbBTC: { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
  },
  avalanche: {
    AVAX:  { symbol: 'AVAX',  address: NATIVE_ASSET_SENTINEL, decimals: 18 },
    WAVAX: { symbol: 'WAVAX', address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', decimals: 18, wrapsNative: true },
    USDC:  { symbol: 'USDC',  address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
    USDT:  { symbol: 'USDT',  address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
    DAIe:  { symbol: 'DAI.e', address: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', decimals: 18 },
    WETHe: { symbol: 'WETH.e', address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', decimals: 18 },
  },
  arbitrum: {
    ETH:  { symbol: 'ETH',  address: NATIVE_ASSET_SENTINEL, decimals: 18 },
    WETH: { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, wrapsNative: true },
    USDC: { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    USDT: { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  },
  optimism: {
    ETH:  { symbol: 'ETH',  address: NATIVE_ASSET_SENTINEL, decimals: 18 },
    WETH: { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, wrapsNative: true },
    USDC: { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
  },
  polygon: {
    POL:   { symbol: 'POL',   address: NATIVE_ASSET_SENTINEL, decimals: 18 },
    WPOL:  { symbol: 'WPOL',  address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18, wrapsNative: true },
    USDC:  { symbol: 'USDC',  address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    USDT:  { symbol: 'USDT',  address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
  },
};

const SYMBOL_ALIASES: Record<string, string> = {
  USD: 'USDC',
  BTC: 'WBTC',
};

export function tokenFor(chain: EvmChain, symbol: string): TokenInfo | null {
  const upper = symbol.toUpperCase();
  const byChain = TOKENS[chain];
  if (!byChain) return null;
  const direct = byChain[upper] ?? byChain[symbol];
  if (direct) return direct;
  const aliased = SYMBOL_ALIASES[upper];
  if (aliased) {
    const fromAlias = byChain[aliased];
    if (fromAlias) return fromAlias;
  }
  for (const t of Object.values(byChain)) {
    if (t.symbol.toUpperCase() === upper) return t;
  }
  return null;
}

export function isEvmChain(s: string): s is EvmChain {
  return s in EVM_CHAIN_IDS;
}

/** Convert a decimal amount string to wei-style integer string given decimals. */
export function toBaseUnits(amount: string, decimals: number): string {
  const [whole, frac = ''] = amount.split('.');
  const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const joined = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, '');
  return joined === '' ? '0' : joined;
}

/** Convert a wei-style integer string to a decimal amount string. */
export function fromBaseUnits(amount: string, decimals: number): string {
  const trimmed = amount.replace(/^0+/, '') || '0';
  if (decimals === 0) return trimmed;
  const padded = trimmed.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
