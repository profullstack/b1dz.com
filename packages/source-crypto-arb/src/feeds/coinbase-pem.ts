/**
 * Shared Coinbase PEM key resolver — handles Railway's env var mangling.
 * Tries COINBASE_API_PRIVATE_KEY_B64 (base64-encoded, Railway-safe) first,
 * falls back to COINBASE_API_PRIVATE_KEY (raw PEM, works locally).
 */

let cached: string | null | undefined;

export function getCoinbasePem(): string | null {
  if (cached !== undefined) return cached;

  // Try base64-encoded key first (Railway-safe)
  const b64Key = process.env.COINBASE_API_PRIVATE_KEY_B64;
  console.log(`[coinbase-pem] B64 env set: ${!!b64Key} (${b64Key?.length ?? 0} chars)`);
  if (b64Key) {
    cached = Buffer.from(b64Key, 'base64').toString('utf8');
    console.log(`[coinbase] PEM from B64 (${cached.length} chars)`);
    return cached;
  }

  // Fall back to raw PEM
  const privateKey = process.env.COINBASE_API_PRIVATE_KEY;
  if (!privateKey) { cached = null; return null; }

  const raw = privateKey.replace(/\\n/g, '\n');
  const b64 = raw.replace(/-----(BEGIN|END) EC PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const lines = b64.match(/.{1,64}/g) ?? [];
  cached = `-----BEGIN EC PRIVATE KEY-----\n${lines.join('\n')}\n-----END EC PRIVATE KEY-----\n`;
  console.log(`[coinbase] PEM from raw (${cached.length} chars)`);
  return cached;
}
// cache bust Sun Apr 12 01:16:20 AM UTC 2026
