/**
 * Direct EVM wallet provider (PRD §15A fallback).
 *
 * Signs with a raw secp256k1 private key via viem. Used when the
 * CoinPay CLI path is unavailable or when the trade daemon needs
 * non-interactive signing on the server.
 *
 * Key material lives in this process's memory — keep the private key
 * in an env var loaded from a secret manager, never commit it, and
 * prefer the CoinPay path when the operator can tolerate interactive
 * signing.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes, bytesToHex, keccak256, type Hex } from 'viem';
import {
  WalletProviderError,
  type WalletProvider,
  type WalletChain,
  type ProviderCapability,
  type SignDigestRequest,
  type SignMessageRequest,
} from '@b1dz/wallet-provider';

const EVM_CHAINS: readonly WalletChain[] = [
  'ethereum', 'base', 'avalanche', 'arbitrum', 'optimism', 'polygon', 'bnb',
];

export interface DirectEvmWalletProviderOptions {
  /** 0x-prefixed 32-byte secp256k1 private key. Defaults to
   *  `process.env.EVM_PRIVATE_KEY`. */
  privateKey?: Hex;
  /** Override the chain allowlist (e.g. disable mainnet). */
  chains?: readonly WalletChain[];
}

export class DirectEvmWalletProvider implements WalletProvider {
  readonly id = 'direct-evm';
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly chains: readonly WalletChain[];

  constructor(opts: DirectEvmWalletProviderOptions = {}) {
    const pk = opts.privateKey ?? (process.env.EVM_PRIVATE_KEY as Hex | undefined);
    if (!pk) {
      throw new WalletProviderError(
        'internal',
        'DirectEvmWalletProvider requires a private key (opts.privateKey or EVM_PRIVATE_KEY env)',
      );
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new WalletProviderError('internal', 'EVM private key must be 0x-prefixed 32-byte hex');
    }
    this.account = privateKeyToAccount(pk);
    this.chains = opts.chains ?? EVM_CHAINS;
  }

  capabilities(): readonly ProviderCapability[] {
    return ['sign-digest', 'sign-message', 'get-address'];
  }

  supportedChains(): readonly WalletChain[] {
    return this.chains;
  }

  async getAddress(chain: WalletChain): Promise<string> {
    this.assertChain(chain);
    // Same address across every EVM chain since they share BIP44 60.
    return this.account.address;
  }

  async signDigest(req: SignDigestRequest): Promise<string> {
    this.assertChain(req.chain);
    if (!/^0x[0-9a-fA-F]{64}$/.test(req.digestHex)) {
      throw new WalletProviderError('internal', 'digest must be 0x-prefixed 32-byte hex');
    }
    const sig = await this.account.sign({ hash: req.digestHex as Hex });
    return sig;
  }

  async signMessage(req: SignMessageRequest): Promise<string> {
    this.assertChain(req.chain);
    // EIP-191 personal_sign path — viem prepends the "\x19Ethereum
    // Signed Message:\n" prefix and hashes for us.
    const message = typeof req.message === 'string'
      ? req.message
      : { raw: bytesToHex(req.message) as Hex };
    return this.account.signMessage({ message });
  }

  private assertChain(chain: WalletChain): void {
    if (chain === 'solana') {
      throw new WalletProviderError(
        'not-supported',
        'DirectEvmWalletProvider cannot sign for Solana — use DirectSolanaWalletProvider',
      );
    }
    if (!this.chains.includes(chain)) {
      throw new WalletProviderError('not-supported', `chain ${chain} not in allowlist`);
    }
  }
}

/** Re-export of keccak256 so callers that need to hash calldata before
 *  `signDigest()` don't have to take a viem dep themselves. */
export { keccak256, hexToBytes, bytesToHex };
