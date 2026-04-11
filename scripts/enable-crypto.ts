import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SECRET_KEY!;
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Find users
  const { data: authUsers } = await sb.auth.admin.listUsers();
  console.log('Users:', authUsers?.users?.map(u => ({ id: u.id, email: u.email })));

  const userId = authUsers?.users?.[0]?.id;
  if (!userId) {
    console.error('No users found');
    return;
  }
  console.log(`\nEnabling crypto sources for user ${userId}...`);

  for (const sourceId of ['crypto-arb', 'crypto-trade']) {
    const { error } = await sb.from('source_state').upsert(
      { user_id: userId, source_id: sourceId, payload: { enabled: true, exchange: 'kraken' }, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,source_id' },
    );
    if (error) console.error(`${sourceId} error:`, error);
    else console.log(`✓ ${sourceId} enabled`);
  }
}
main();
