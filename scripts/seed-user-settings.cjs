'use strict';
/**
 * Seed encrypted user settings into Supabase user_settings table.
 * Run from the b1dz.com root with railway so env is available:
 *   railway run --service b1dz.com -- sh -c "cd apps/web && node ../../scripts/seed-user-settings.cjs"
 */
const { createClient } = require('@supabase/supabase-js');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY;
const ENC_KEY_B64 = process.env.SETTINGS_ENCRYPTION_KEY;
const USER_EMAIL = process.env.SEED_USER_EMAIL || 'anthony@profullstack.com';

if (!SUPABASE_URL || !SUPABASE_SECRET || !ENC_KEY_B64) {
  console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY / SETTINGS_ENCRYPTION_KEY');
  process.exit(1);
}

// Secrets to encrypt
const COINBASE_PRIVATE_KEY_B64 = process.env.COINBASE_API_PRIVATE_KEY_B64 || '';
const COINBASE_PRIVATE_KEY = COINBASE_PRIVATE_KEY_B64
  ? Buffer.from(COINBASE_PRIVATE_KEY_B64, 'base64').toString('utf8')
  : '';

const secrets = {
  BINANCE_US_API_KEY: process.env.BINANCE_US_API_KEY || '',
  BINANCE_US_API_SECRET: process.env.BINANCE_US_API_SECRET || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_API_SECRET: process.env.GEMINI_API_SECRET || '',
  KRAKEN_API_KEY: process.env.KRAKEN_API_KEY || '',
  KRAKEN_API_SECRET: process.env.KRAKEN_API_SECRET || '',
  EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY || '',
  SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY || '',
  ZEROX_API_KEY: process.env.ZEROX_API_KEY || '',
  COINBASE_API_PRIVATE_KEY: COINBASE_PRIVATE_KEY,
};
for (const [k, v] of Object.entries(secrets)) { if (!v) delete secrets[k]; }

// Plain non-secret fields
const plain = {};
if (process.env.COINBASE_API_KEY_NAME) plain.COINBASE_API_KEY_NAME = process.env.COINBASE_API_KEY_NAME;
if (process.env.GEMINI_ACCOUNT) plain.GEMINI_ACCOUNT = process.env.GEMINI_ACCOUNT;

function encryptJson(keyB64, obj) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(obj);
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);

  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) { console.error('listUsers:', listErr.message); process.exit(1); }
  const user = users.find((u) => u.email === USER_EMAIL);
  if (!user) { console.error(`User not found: ${USER_EMAIL}`); process.exit(1); }
  console.log(`Found user ${user.email} id=${user.id}`);

  const { data: existing } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  const mergedPlain = { ...(existing?.payload_plain ?? {}), ...plain };

  let existingSecrets = {};
  if (existing?.payload_secret_ciphertext && existing.payload_secret_iv && existing.payload_secret_tag) {
    try {
      const key = Buffer.from(ENC_KEY_B64, 'base64');
      const iv = Buffer.from(existing.payload_secret_iv, 'base64');
      const ct = Buffer.from(existing.payload_secret_ciphertext, 'base64');
      const tag = Buffer.from(existing.payload_secret_tag, 'base64');
      const dec = createDecipheriv('aes-256-gcm', key, iv);
      dec.setAuthTag(tag);
      const plaintext = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
      existingSecrets = JSON.parse(plaintext);
      console.log(`Decrypted ${Object.keys(existingSecrets).length} existing secrets`);
    } catch (e) {
      console.warn('Could not decrypt existing cipher (will overwrite):', e.message);
    }
  }

  const mergedSecrets = { ...existingSecrets, ...secrets };
  const cipher = encryptJson(ENC_KEY_B64, mergedSecrets);

  console.log(`Saving ${Object.keys(mergedSecrets).length} secrets: ${Object.keys(mergedSecrets).join(', ')}`);
  console.log(`Saving ${Object.keys(mergedPlain).length} plain: ${Object.keys(mergedPlain).join(', ')}`);

  const { error: upsertErr } = await supabase.from('user_settings').upsert({
    user_id: user.id,
    payload_plain: mergedPlain,
    payload_secret_ciphertext: cipher.ciphertext,
    payload_secret_iv: cipher.iv,
    payload_secret_tag: cipher.tag,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });

  if (upsertErr) { console.error('Upsert failed:', upsertErr.message); process.exit(1); }
  console.log('Done. Settings saved successfully.');
}

main().catch((e) => { console.error(e); process.exit(1); });
