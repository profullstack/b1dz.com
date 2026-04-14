import { describe, expect, it } from 'vitest';
import { verifyMessage, recoverAddress, hashMessage, type Hex } from 'viem';
import { DirectEvmWalletProvider } from './evm.js';
import { WalletProviderError } from '@b1dz/wallet-provider';

// Well-known test key — secp256k1 generator point. Safe to commit.
const PK = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;
const ADDR = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

describe('DirectEvmWalletProvider', () => {
  it('throws when no private key is provided', () => {
    const prev = process.env.EVM_PRIVATE_KEY;
    delete process.env.EVM_PRIVATE_KEY;
    expect(() => new DirectEvmWalletProvider()).toThrow(WalletProviderError);
    if (prev !== undefined) process.env.EVM_PRIVATE_KEY = prev;
  });

  it('rejects malformed private keys', () => {
    expect(() => new DirectEvmWalletProvider({ privateKey: '0xdeadbeef' as Hex })).toThrow(/32-byte/);
  });

  it('exposes the derived address identically across all EVM chains', async () => {
    const w = new DirectEvmWalletProvider({ privateKey: PK });
    expect(await w.getAddress('ethereum')).toBe(ADDR);
    expect(await w.getAddress('base')).toBe(ADDR);
    expect(await w.getAddress('avalanche')).toBe(ADDR);
    expect(await w.getAddress('arbitrum')).toBe(ADDR);
  });

  it('refuses Solana', async () => {
    const w = new DirectEvmWalletProvider({ privateKey: PK });
    await expect(w.getAddress('solana')).rejects.toThrow(/Solana/);
  });

  it('honors the chains allowlist override', async () => {
    const w = new DirectEvmWalletProvider({ privateKey: PK, chains: ['base'] });
    expect(await w.getAddress('base')).toBe(ADDR);
    await expect(w.getAddress('ethereum')).rejects.toThrow(/allowlist/);
  });

  it('signMessage produces an EIP-191 signature verifiable against the address', async () => {
    const w = new DirectEvmWalletProvider({ privateKey: PK });
    const sig = await w.signMessage({ chain: 'base', message: 'hello world' });
    const ok = await verifyMessage({ address: ADDR as Hex, message: 'hello world', signature: sig as Hex });
    expect(ok).toBe(true);
  });

  it('signDigest produces an ECDSA signature that recovers to the correct address', async () => {
    const w = new DirectEvmWalletProvider({ privateKey: PK });
    // Use viem's hashMessage so we sign over a known-valid 32-byte digest.
    const digest = hashMessage('integration test');
    const sig = await w.signDigest({ chain: 'base', digestHex: digest });
    const recovered = await recoverAddress({ hash: digest, signature: sig as Hex });
    expect(recovered.toLowerCase()).toBe(ADDR.toLowerCase());
  });

  it('rejects a non-32-byte digest', async () => {
    const w = new DirectEvmWalletProvider({ privateKey: PK });
    await expect(w.signDigest({ chain: 'base', digestHex: '0x1234' })).rejects.toThrow(/32-byte/);
  });

  it('advertises the expected capabilities', () => {
    const w = new DirectEvmWalletProvider({ privateKey: PK });
    expect(w.capabilities()).toContain('sign-digest');
    expect(w.capabilities()).toContain('sign-message');
    expect(w.capabilities()).not.toContain('sign-solana-message');
  });
});
