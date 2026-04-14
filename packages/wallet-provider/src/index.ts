/**
 * Wallet-provider abstraction (PRD §15A).
 *
 * The DEX engine needs to sign things without caring who owns the
 * private key. Three implementations are planned:
 *   1. @b1dz/wallet-direct      — raw private key, viem + @solana/web3.js
 *   2. @b1dz/wallet-coinpay     — shells out to `coinpay wallet sign-*`
 *   3. @b1dz/wallet-hsm (later) — any KMS / HSM
 *
 * Every adapter in the venue stack talks to this interface, not to
 * keys directly. That keeps the execution path pluggable and prevents
 * private key material from leaking into adapter code.
 */

/** Chain slugs recognized by wallet providers. EVM chains use the
 *  same slugs the adapters-evm package exposes; Solana uses "solana". */
export type WalletChain =
  | 'ethereum'
  | 'base'
  | 'avalanche'
  | 'arbitrum'
  | 'optimism'
  | 'polygon'
  | 'bnb'
  | 'solana';

export interface SignDigestRequest {
  chain: WalletChain;
  /** 0x-prefixed 32-byte digest to sign (EIP-1559 / EIP-2930 / EIP-155). */
  digestHex: string;
}

export interface SignMessageRequest {
  chain: WalletChain;
  /** UTF-8 message for EIP-191 personal_sign on EVM, arbitrary bytes
   *  for Solana message signing. */
  message: string | Uint8Array;
}

export interface SignSolanaTxRequest {
  /** Serialized Solana VersionedMessage bytes or hex. */
  message: string | Uint8Array;
  /** Derivation index. Defaults to 0. */
  index?: number;
}

export interface BroadcastRequest {
  chain: WalletChain;
  /** 0x-prefixed signed transaction hex ready for `eth_sendRawTransaction`
   *  (EVM) or base64 for Solana. */
  signedTx: string;
}

export type ProviderCapability =
  | 'sign-digest'
  | 'sign-message'
  | 'sign-solana-message'
  | 'broadcast-evm'
  | 'broadcast-solana'
  | 'get-balance'
  | 'get-address';

export interface WalletProvider {
  readonly id: string;
  /** Which capabilities this provider implements. Daemon uses this to
   *  pick the right provider per operation. */
  capabilities(): readonly ProviderCapability[];
  /** Which chains this provider has a key for. */
  supportedChains(): readonly WalletChain[];

  getAddress(chain: WalletChain): Promise<string>;
  getBalance?(chain: WalletChain, asset?: string): Promise<string>;

  signDigest?(req: SignDigestRequest): Promise<string>;
  signMessage?(req: SignMessageRequest): Promise<string>;
  signSolanaMessage?(req: SignSolanaTxRequest): Promise<string>;

  /** Optional: broadcast a pre-signed tx. Most providers leave this to
   *  the caller's RPC client (viem / @solana/web3.js). */
  broadcast?(req: BroadcastRequest): Promise<string>;
}

/** Narrow typed error surface so daemon can distinguish "not supported"
 *  from "user rejected" from "network failure". */
export class WalletProviderError extends Error {
  constructor(
    public readonly code: 'not-supported' | 'locked' | 'rejected' | 'network' | 'internal',
    message: string,
  ) {
    super(message);
    this.name = 'WalletProviderError';
  }
}
