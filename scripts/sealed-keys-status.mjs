#!/usr/bin/env node
/**
 * How many user_settings rows still hold legacy (server-key) ciphertext.
 * Prints COUNTS only — never row contents. Run before setting the
 * LEGACY_KEY_MIGRATION=off cutoff:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_KEY=… node scripts/sealed-keys-status.mjs
 *
 * Equivalent SQL: select * from public.user_settings_seal_status;
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await sb.from('user_settings_seal_status').select('*').single();
if (error) {
  console.error(`query failed: ${error.message}`);
  process.exit(1);
}
console.log(JSON.stringify(data));
