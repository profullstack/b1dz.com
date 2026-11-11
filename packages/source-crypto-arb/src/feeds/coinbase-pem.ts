/**
 * Shared Coinbase PEM key resolver.
 *
 * Supports:
 * - COINBASE_EC_KEY_B64: base64 of the raw EC key body
 * - COINBASE_API_PRIVATE_KEY_B64: base64 of the full PEM
 * - COINBASE_API_PRIVATE_KEY: the whole downloaded key file (JSON with
 *   "name"/"id" and "privateKey"), a raw PEM (SEC1 "EC PRIVATE KEY" or PKCS#8
 *   "PRIVATE KEY"), or a CDP Ed25519 secret (base64, 64 bytes: seed then public key)
 *
 * Coinbase App / Advanced Trade (api.coinbase.com/api/v3/brokerage) accepts
 * ECDSA (ES256) keys only: "Ed25519 (EdDSA) keys are NOT supported. You must use
 * ES256" (docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication).
 * kid and sub are the full "organizations/{org}/apiKeys/{key}" name.
 */
import { createPrivateKey, createPublicKey, createSign, sign as edSign, type KeyObject } from 'node:crypto';

interface CoinbaseKeyFile { name?: string; id?: string; privateKey?: string }

/** The downloaded key file pasted whole (JSON), or null. */
export function parseCoinbaseKeyFile(raw: string | undefined | null): CoinbaseKeyFile | null {
  const v = (raw ?? '').trim();
  if (!v.startsWith('{')) return null;
  try {
    const j = JSON.parse(v) as Record<string, unknown>;
    const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string).trim() : undefined);
    const privateKey = str('privateKey') ?? str('private_key') ?? str('secret');
    if (!privateKey) return null;
    return { name: str('name'), id: str('id'), privateKey };
  } catch {
    return null;
  }
}

/** The private key material, unwrapped from a pasted key file when needed. */
function rawPrivateKey(): string | undefined {
  const raw = process.env.COINBASE_API_PRIVATE_KEY;
  return parseCoinbaseKeyFile(raw)?.privateKey ?? raw;
}

const FULL_NAME = /^organizations\/[^/]+\/apiKeys\/[^/]+$/;

/**
 * The key name for kid/sub. A full organizations/.../apiKeys/... name wins
 * (from the field or from a pasted key file); otherwise whatever was entered.
 */
export function getCoinbaseKeyName(): string | null {
  const entered = (process.env.COINBASE_API_KEY_NAME ?? '').trim();
  const file = parseCoinbaseKeyFile(process.env.COINBASE_API_PRIVATE_KEY);
  if (FULL_NAME.test(entered)) return entered;
  if (file?.name && FULL_NAME.test(file.name)) return file.name;
  return entered || file?.name || file?.id || null;
}

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
  const ed = parseEd25519Secret(rawPrivateKey());
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

  const rawPem = rawPrivateKey();
  if (!rawPem) return null;
  // An Ed25519 secret is not a PEM; wrapping it in EC headers would make garbage.
  if (parseEd25519Secret(rawPem)) return null;

  const normalized = rawPem.replace(/\\n/g, '\n');
  // Keep the key's own type: SEC1 "EC PRIVATE KEY" or PKCS#8 "PRIVATE KEY".
  const label = /-----BEGIN PRIVATE KEY-----/.test(normalized) ? 'PRIVATE KEY' : 'EC PRIVATE KEY';
  const body = normalized
    .replace(/-----(BEGIN|END) (EC )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
