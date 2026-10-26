import { createProfileStore, type ProfileStore } from '@profullstack/profile';
import { createAdminSupabase } from '@/lib/supabase';

// The shared @profullstack/profile fields live in public.user_profiles keyed by
// the auth user id. RLS is on with no policies, so only this server-side
// service-role client reads or writes it.
let cached: ProfileStore | null = null;

export function profileStore(): ProfileStore {
  cached ??= createProfileStore(createAdminSupabase(), { table: 'user_profiles', key: 'user_id' });
  return cached;
}
