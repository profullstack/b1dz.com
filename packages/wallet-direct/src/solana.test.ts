import { describe, expect, it } from 'vitest';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
  DirectSolanaWalletProvider,
  base58decode,
  base58encode,
} from './solana.js';
import { WalletProviderError } from '@b1dz/wallet-provider';

/** Deterministic 32-byte seed for tests. */
const SEED_HEX = '0x' + '01'.repeat(32);

describe('base58', () => {
  it('encodes an all-zero 32-byte buffer to 32 ones (Solana System Program)', () => {
    const bytes = new Uint8Array(32);
    expect(base58encode(bytes)).toBe('1'.repeat(32));
  });

  it('round-trips arbitrary payloads', () => {
    const fixtures = [
      new Uint8Array([0]),
      new Uint8Array([0, 0, 1, 2, 3]),
      new Uint8Array([255, 254, 253, 252, 0, 1]),
      new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff)),
    ];
    for (const f of fixtures) {
      const encoded = base58encode(f);
      const decoded = base58decode(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(f));
    }
  });

  it('rejects invalid base58 characters (no 0/O/I/l)', () => {
    expect(() => base58decode('0abc')).toThrow(/invalid base58/);
  });
});

describe('DirectSolanaWalletProvider', () => {
  it('throws when no secret is provided', () => {
    const prev = process.env.SOLANA_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
    expect(() => new DirectSolanaWalletProvider()).toThrow(WalletProviderError);
    if (prev !== undefined) process.env.SOLANA_PRIVATE_KEY = prev;
  });

  it('accepts a 32-byte seed as hex', async () => {
    const w = new DirectSolanaWalletProvider({ secretKey: SEED_HEX });
    const addr = await w.getAddress('solana');
    expect(addr.length).toBeGreaterThan(32);
    expect(addr.length).toBeLessThan(45);
    // Solana addresses must base58-decode to exactly 32 bytes.
    expect(base58decode(addr).length).toBe(32);
  });

  it('accepts a JSON array in solana-keygen format', async () => {
    const seed = Array.from({ length: 32 }, () => 1);
    const w1 = new DirectSolanaWalletProvider({ secretKey: JSON.stringify(seed) });
    const w2 = new DirectSolanaWalletProvider({ secretKey: SEED_HEX });
    expect(await w1.getAddress('solana')).toBe(await w2.getAddress('solana'));
  });

  it('validates the embedded pubkey when given a 64-byte keypair', () => {
    // 64-byte payload whose trailing 32 bytes don't match the seed's pubkey.
    const bad = JSON.stringify([...new Array(32).fill(1), ...new Array(32).fill(0)]);
    expect(() => new DirectSolanaWalletProvider({ secretKey: bad })).toThrow(/malformed|pubkey/);
  });

  it('rejects non-solana chains', async () => {
    const w = new DirectSolanaWalletProvider({ secretKey: SEED_HEX });
    await expect(w.getAddress('base')).rejects.toThrow(/does not support/);
  });

  it('signSolanaMessage output is 64 bytes and verifies against the derived pubkey', async () => {
    const w = new DirectSolanaWalletProvider({ secretKey: SEED_HEX });
    const message = new TextEncoder().encode('jupiter swap v6');
    const sigB58 = await w.signSolanaMessage({ message });
    const sig = base58decode(sigB58);
    expect(sig.length).toBe(64);

    const addr = await w.getAddress('solana');
    const pubKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(base58decode(addr)).toString('base64url') },
      format: 'jwk',
    });
    const ok = cryptoVerify(null, Buffer.from(message), pubKey, Buffer.from(sig));
    expect(ok).toBe(true);
  });

  it('signMessage with a utf-8 string matches signSolanaMessage over the same bytes', async () => {
    const w = new DirectSolanaWalletProvider({ secretKey: SEED_HEX });
    // ed25519 is deterministic — same message → same sig.
    const s1 = await w.signMessage({ chain: 'solana', message: 'hello' });
    const s2 = await w.signSolanaMessage({ message: new TextEncoder().encode('hello') });
    expect(s1).toBe(s2);
  });

  it('advertises the expected capabilities', () => {
    const w = new DirectSolanaWalletProvider({ secretKey: SEED_HEX });
    expect(w.capabilities()).toContain('sign-solana-message');
    expect(w.capabilities()).toContain('sign-message');
    expect(w.capabilities()).not.toContain('sign-digest');
    expect(w.supportedChains()).toEqual(['solana']);
  });
});
