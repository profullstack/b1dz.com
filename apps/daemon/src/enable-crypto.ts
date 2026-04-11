import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SECRET_KEY!;
const sb = createClient(url, key, { auth: { persistSession: false } });

const { data: authUsers } = await sb.auth.admin.listUsers();

// Enable for ALL users
for (const user of authUsers?.users ?? []) {
  console.log(`Enabling crypto for ${user.email} (${user.id})...`);
  for (const sourceId of ['crypto-arb', 'crypto-trade']) {
    const { error } = await sb.from('source_state').upsert(
      { user_id: user.id, source_id: sourceId, payload: { enabled: true, exchange: 'kraken' }, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,source_id' },
    );
    console.log(error ? `  ✗ ${sourceId}: ${error.message}` : `  ✓ ${sourceId}`);
  }
}
