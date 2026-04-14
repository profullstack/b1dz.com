/**
 * Direct signer providers — fallback WalletProvider implementations
 * for when the CoinPay CLI path is unavailable or when the trade
 * daemon needs non-interactive signing on a server (PRD §15A, §11B).
 */

export { DirectEvmWalletProvider } from './evm.js';
export type { DirectEvmWalletProviderOptions } from './evm.js';
export { DirectSolanaWalletProvider } from './solana.js';
export type { DirectSolanaWalletProviderOptions } from './solana.js';
export { base58encode, base58decode } from './solana.js';
