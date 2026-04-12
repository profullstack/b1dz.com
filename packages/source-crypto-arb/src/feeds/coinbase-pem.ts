/**
 * Shared Coinbase PEM key resolver — handles Railway's env var mangling.
 * Tries COINBASE_API_PRIVATE_KEY_B64 (base64-encoded, Railway-safe) first,
 * falls back to COINBASE_API_PRIVATE_KEY (raw PEM, works locally).
 */

export function getCoinbasePem(): string | null {
  // Try base64-encoded key first (Railway-safe, no line-breaking issues)
  const b64Key = process.env.COINBASE_API_PRIVATE_KEY_B64;
  if (b64Key && b64Key.length > 10) {
    return Buffer.from(b64Key, 'base64').toString('utf8');
  }

  // Fall back to raw PEM (works locally)
  const privateKey = process.env.COINBASE_API_PRIVATE_KEY;
  if (!privateKey) return null;

  const raw = privateKey.replace(/\\n/g, '\n');
  const b64 = raw.replace(/-----(BEGIN|END) EC PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN EC PRIVATE KEY-----\n${lines.join('\n')}\n-----END EC PRIVATE KEY-----\n`;
}
