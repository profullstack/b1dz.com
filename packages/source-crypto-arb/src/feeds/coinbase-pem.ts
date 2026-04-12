/**
 * Shared Coinbase PEM key resolver — handles Railway's env var mangling.
 * Tries COINBASE_API_PRIVATE_KEY_B64 (base64-encoded, Railway-safe) first,
 * falls back to COINBASE_API_PRIVATE_KEY (raw PEM, works locally).
 */

export function getCoinbasePem(): string | null {
  // Option 1: Raw key content as base64 (shortest, Railway-safe)
  const ecKeyB64 = process.env.COINBASE_EC_KEY_B64;
  if (ecKeyB64 && ecKeyB64.length > 10) {
    const cleaned = ecKeyB64.replace(/\s/g, '');
    const lines = cleaned.match(/.{1,64}/g) ?? [];
    return `-----BEGIN EC PRIVATE KEY-----\n${lines.join('\n')}\n-----END EC PRIVATE KEY-----\n`;
  }

  // Option 2: Full PEM as base64
  const b64Key = process.env.COINBASE_API_PRIVATE_KEY_B64;
  if (b64Key && b64Key.length > 10) {
    const cleaned = b64Key.replace(/\s/g, '');
    return Buffer.from(cleaned, 'base64').toString('utf8');
  }

  // Option 3: Raw PEM string (works locally)
  const privateKey = process.env.COINBASE_API_PRIVATE_KEY;
  if (!privateKey) return null;

  const raw = privateKey.replace(/\\n/g, '\n');
  const b64 = raw.replace(/-----(BEGIN|END) EC PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN EC PRIVATE KEY-----\n${lines.join('\n')}\n-----END EC PRIVATE KEY-----\n`;
}
