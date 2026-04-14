/**
 * Direct Solana wallet provider (PRD §15A, §16.1 fallback).
 *
 * Signs with a raw ed25519 keypair via Node's built-in crypto — no
 * `@solana/web3.js` runtime dep. CoinPay Solana coverage may be
 * incomplete per PRD §11B, so the daemon falls back here for Solana
 * signing in live mode.
 *
 * Key material lives in this process's memory — keep the secret in an
 * env var loaded from a secret manager.
 *
 * Input formats accepted for the 64-byte secret key (standard Solana
 * keypair layout, seed || public):
 *   - JSON array of 64 integers (what `solana-keygen new` emits)
 *   - base58 string
 *   - 0x-prefixed 128-char hex
 *
 * We also accept a bare 32-byte seed and derive the public half from it.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import {
  WalletProviderError,
  type WalletProvider,
  type WalletChain,
  type ProviderCapability,
  type SignMessageRequest,
  type SignSolanaTxRequest,
} from '@b1dz/wallet-provider';

export interface DirectSolanaWalletProviderOptions {
  /** 64-byte Solana secret (seed||pub) in JSON-array / base58 / hex form,
   *  or a 32-byte seed alone. Defaults to `process.env.SOLANA_PRIVATE_KEY`. */
  secretKey?: string;
}

export class DirectSolanaWalletProvider implements WalletProvider {
  readonly id = 'direct-solana';
  private readonly privateKey: KeyObject;
  private readonly publicKey: Uint8Array;
  private readonly addressCache: string;

  constructor(opts: DirectSolanaWalletProviderOptions = {}) {
    const raw = opts.secretKey ?? process.env.SOLANA_PRIVATE_KEY;
    if (!raw) {
      throw new WalletProviderError(
        'internal',
        'DirectSolanaWalletProvider requires a secret (opts.secretKey or SOLANA_PRIVATE_KEY env)',
      );
    }
    const bytes = parseSolanaSecret(raw);
    const seed = bytes.length === 64 ? bytes.subarray(0, 32) : bytes;

    // Node ed25519 KeyObject via PKCS8 DER. We can't use JWK here
    // because RFC 8037 requires `x` (the public key) on private-key
    // JWKs, which we haven't derived yet. PKCS8 only needs the seed.
    this.privateKey = createPrivateKey({
      key: ed25519Pkcs8(seed),
      format: 'der',
      type: 'pkcs8',
    });
    const pubJwk = createPublicKey(this.privateKey).export({ format: 'jwk' }) as { x?: string };
    if (!pubJwk.x) {
      throw new WalletProviderError('internal', 'failed to derive ed25519 public key');
    }
    this.publicKey = base64urlDecode(pubJwk.x);

    // If the caller passed a full 64-byte keypair, sanity-check that the
    // embedded pubkey matches the one we just derived.
    if (bytes.length === 64) {
      const embedded = bytes.subarray(32);
      if (!constantTimeEqual(embedded, this.publicKey)) {
        throw new WalletProviderError(
          'internal',
          'Solana secret key appears malformed: embedded pubkey does not match seed-derived pubkey',
        );
      }
    }
    this.addressCache = base58encode(this.publicKey);
  }

  capabilities(): readonly ProviderCapability[] {
    return ['sign-message', 'sign-solana-message', 'get-address'];
  }

  supportedChains(): readonly WalletChain[] {
    return ['solana'];
  }

  async getAddress(chain: WalletChain): Promise<string> {
    this.assertSolana(chain);
    return this.addressCache;
  }

  async signMessage(req: SignMessageRequest): Promise<string> {
    this.assertSolana(req.chain);
    const message = typeof req.message === 'string'
      ? new TextEncoder().encode(req.message)
      : req.message;
    return this.sign(message);
  }

  async signSolanaMessage(req: SignSolanaTxRequest): Promise<string> {
    const message = normalizeMessage(req.message);
    return this.sign(message);
  }

  private sign(message: Uint8Array): string {
    // ed25519 via Node crypto: algorithm param must be null.
    const sig = cryptoSign(null, Buffer.from(message), this.privateKey);
    return base58encode(new Uint8Array(sig));
  }

  private assertSolana(chain: WalletChain): void {
    if (chain !== 'solana') {
      throw new WalletProviderError(
        'not-supported',
        `DirectSolanaWalletProvider does not support ${chain}`,
      );
    }
  }
}

// ─── Input parsing ────────────────────────────────────────────────

function parseSolanaSecret(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(arr) || !arr.every((n) => typeof n === 'number' && n >= 0 && n < 256)) {
      throw new WalletProviderError('internal', 'Solana secret JSON array must contain bytes 0-255');
    }
    if (arr.length !== 32 && arr.length !== 64) {
      throw new WalletProviderError('internal', `Solana secret must be 32 or 64 bytes, got ${arr.length}`);
    }
    return Uint8Array.from(arr as number[]);
  }
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    const hex = trimmed.slice(2);
    if (hex.length !== 64 && hex.length !== 128) {
      throw new WalletProviderError('internal', 'Solana hex secret must be 32 or 64 bytes');
    }
    return hexToBytes(hex);
  }
  // Assume base58.
  const decoded = base58decode(trimmed);
  if (decoded.length !== 32 && decoded.length !== 64) {
    throw new WalletProviderError('internal', `base58 Solana secret must decode to 32 or 64 bytes, got ${decoded.length}`);
  }
  return decoded;
}

function normalizeMessage(message: string | Uint8Array): Uint8Array {
  if (typeof message !== 'string') return message;
  if (message.startsWith('0x')) return hexToBytes(message.slice(2));
  // Tolerate callers that hand us bare hex without a prefix.
  if (/^[0-9a-fA-F]+$/.test(message) && message.length % 2 === 0) return hexToBytes(message);
  return new TextEncoder().encode(message);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new WalletProviderError('internal', 'hex length must be even');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─── Ed25519 PKCS8 DER construction ───────────────────────────────
// RFC 8410: Ed25519 PrivateKeyInfo is a fixed 16-byte ASN.1 prefix
// followed by OCTET STRING(OCTET STRING(seed)).
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, // SEQUENCE, 46 bytes
  0x02, 0x01, 0x00, // INTEGER version = 0
  0x30, 0x05, // SEQUENCE, 5 bytes (AlgorithmIdentifier)
  0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 = Ed25519
  0x04, 0x22, // OCTET STRING, 34 bytes (wraps the inner OCTET STRING)
  0x04, 0x20, // inner OCTET STRING, 32 bytes (the seed)
]);
function ed25519Pkcs8(seed: Uint8Array): Buffer {
  if (seed.length !== 32) {
    throw new WalletProviderError('internal', 'ed25519 seed must be 32 bytes');
  }
  const out = Buffer.alloc(ED25519_PKCS8_PREFIX.length + 32);
  out.set(ED25519_PKCS8_PREFIX, 0);
  out.set(seed, ED25519_PKCS8_PREFIX.length);
  return out;
}

// ─── base64url / base58 ───────────────────────────────────────────

function base64urlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]!] = i;

export function base58encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // Count leading zeros; each becomes a leading '1' in base58.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Big-integer base conversion from 256 → 58.
  const input = Array.from(bytes.subarray(zeros));
  const out: number[] = [];
  while (input.length > 0) {
    let carry = 0;
    const next: number[] = [];
    for (const digit of input) {
      const acc = carry * 256 + digit;
      const q = Math.floor(acc / 58);
      carry = acc % 58;
      if (next.length > 0 || q > 0) next.push(q);
    }
    out.push(carry);
    input.length = 0;
    input.push(...next);
  }
  return '1'.repeat(zeros) + out.reverse().map((i) => B58_ALPHABET[i]).join('');
}

export function base58decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array();
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const v = B58_MAP[s[i]!];
    if (v === undefined) throw new WalletProviderError('internal', `invalid base58 character: ${s[i]}`);
    digits.push(v);
  }
  // Base-58 → base-256 big-integer conversion.
  const input = digits;
  const out: number[] = [];
  while (input.length > 0) {
    let carry = 0;
    const next: number[] = [];
    for (const digit of input) {
      const acc = carry * 58 + digit;
      const q = Math.floor(acc / 256);
      carry = acc % 256;
      if (next.length > 0 || q > 0) next.push(q);
    }
    out.push(carry);
    input.length = 0;
    input.push(...next);
  }
  const body = out.reverse();
  const result = new Uint8Array(zeros + body.length);
  for (let i = 0; i < body.length; i++) result[zeros + i] = body[i]!;
  return result;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
