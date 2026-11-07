/**
 * Shared Coinbase PEM key resolver.
 *
 * Supports:
 * - COINBASE_EC_KEY_B64: base64 of the raw EC key body
 * - COINBASE_API_PRIVATE_KEY_B64: base64 of the full PEM
 * - COINBASE_API_PRIVATE_KEY: raw PEM string, or a CDP Ed25519 secret
 *   (the base64 "Secret" Coinbase shows next to the key ID; 64 bytes:
 *   32-byte seed then 32-byte public key)
 */
import { createPrivateKey, createPublicKey, createSign, sign as edSign, type KeyObject } from 'node:crypto';

/** PKCS#8 DER prefix for an Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Parse a CDP Ed25519 secret. Returns null for anything else (PEMs, junk),
 * so callers fall through to the EC path.
 */
export function parseEd25519Secret(raw: string | undefined | null): KeyObject | null {
  const v = (raw ?? '').trim();
  if (!v || v.includes('-----BEGIN') || !/^[A-Za-z0-9+/=_-]+$/.test(v)) return null;
  const bytes = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length !== 64 && bytes.length !== 32) return null;
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, bytes.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  if (bytes.length === 64) {
    // The second half is the public key; a mismatch means this is not an Ed25519 secret.
    const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
    if (!pub.equals(bytes.subarray(32))) return null;
  }
  return key;
}

export interface CoinbaseSigner {
  alg: 'ES256' | 'EdDSA';
  /** Signature over the JWT signing input, raw bytes as JWS expects. */
  sign(input: string): Buffer;
}

/** The signer for whichever Coinbase key is configured, or null if none. */
export function getCoinbaseSigner(): CoinbaseSigner | null {
  const ed = parseEd25519Secret(process.env.COINBASE_API_PRIVATE_KEY);
  if (ed) return { alg: 'EdDSA', sign: (input) => edSign(null, Buffer.from(input), ed) };
  const pem = getCoinbasePem();
  if (!pem) return null;
  return {
    alg: 'ES256',
    sign: (input) => {
      const s = createSign('SHA256');
      s.update(input);
      return s.sign({ key: pem, dsaEncoding: 'ieee-p1363' });
    },
  };
}

export function getCoinbasePem(): string | null {
  const ecKeyB64 = process.env.COINBASE_EC_KEY_B64;
  if (ecKeyB64 && ecKeyB64.length > 10) {
    const cleaned = ecKeyB64.replace(/\s/g, '');
    const lines = cleaned.match(/.{1,64}/g) ?? [];
    return `-----BEGIN EC PRIVATE KEY-----\n${lines.join('\n')}\n-----END EC PRIVATE KEY-----\n`;
  }

  const pemB64 = process.env.COINBASE_API_PRIVATE_KEY_B64;
  if (pemB64 && pemB64.length > 10) {
    const cleaned = pemB64.replace(/\s/g, '');
    return Buffer.from(cleaned, 'base64').toString('utf8');
  }

  const rawPem = process.env.COINBASE_API_PRIVATE_KEY;
  if (!rawPem) return null;
  // An Ed25519 secret is not a PEM; wrapping it in EC headers would make garbage.
  if (parseEd25519Secret(rawPem)) return null;

  const normalized = rawPem.replace(/\\n/g, '\n');
  const body = normalized
    .replace(/-----(BEGIN|END) EC PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN EC PRIVATE KEY-----\n${lines.join('\n')}\n-----END EC PRIVATE KEY-----\n`;
}
