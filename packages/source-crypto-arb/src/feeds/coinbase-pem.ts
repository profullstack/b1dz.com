/**
 * Shared Coinbase PEM key resolver.
 *
 * Supports:
 * - COINBASE_EC_KEY_B64: base64 of the raw EC key body
 * - COINBASE_API_PRIVATE_KEY_B64: base64 of the full PEM
 * - COINBASE_API_PRIVATE_KEY: raw PEM string
 */

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

  const normalized = rawPem.replace(/\\n/g, '\n');
  const body = normalized
    .replace(/-----(BEGIN|END) EC PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN EC PRIVATE KEY-----\n${lines.join('\n')}\n-----END EC PRIVATE KEY-----\n`;
}
