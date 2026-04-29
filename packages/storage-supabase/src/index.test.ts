/**
 * Integration test — only runs when `INTEGRATION=1` is set in the env, since
 * it talks to a live Supabase project. CI sets the env on a dedicated test
 * project; local dev opts in via `pnpm test:integration`.
 */
import { describe, it } from 'vitest';
import { runStorageContractTests } from '@b1dz/core/storage-contract';
import { SupabaseStorage } from './index.js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const enabled = process.env.INTEGRATION === '1' && url && key;

if (enabled) {
  runStorageContractTests('SupabaseStorage', async () => new SupabaseStorage({ url: url!, key: key! }));
} else {
  describe.skip('SupabaseStorage (integration)', () => {
    it('skipped — set INTEGRATION=1 + Supabase env to run', () => {});
  });
}
