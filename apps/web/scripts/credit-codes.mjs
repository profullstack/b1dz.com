#!/usr/bin/env node
/**
 * Mint and manage b1dz credit codes (unit pro_days) against the live database.
 *
 *   node scripts/credit-codes.mjs mint --days 30 [--label "for X"] [--max 1] [--expires-days 90]
 *   node scripts/credit-codes.mjs list
 *   node scripts/credit-codes.mjs revoke <codeId>
 *   node scripts/credit-codes.mjs grant --user <uuid> --days 7 [--source admin:note]
 *   node scripts/credit-codes.mjs balance --user <uuid>
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SECRET_KEY
 * (or SUPABASE_SERVICE_ROLE_KEY). In production, run it inside the app container:
 *   ssh dev2 'docker exec -w /app/apps/web b1dzcom-app-1 node scripts/credit-codes.mjs mint --days 30 --label "for X"'
 * The plaintext code is printed once; only its sha256 hash is stored.
 */
import { createClient } from '@supabase/supabase-js';
import { Credits, supabaseStore } from '@profullstack/redeem-credits';

const UNIT = 'pro_days';
const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') ? true : rest[++i];
  else positional.push(rest[i]);
}

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required');
  process.exit(1);
}
const credits = new Credits(supabaseStore(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })));

const intFlag = (name, def) => {
  if (flags[name] === undefined) return def;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number >= 1`);
  return n;
};

switch (cmd) {
  case 'mint': {
    const days = intFlag('days');
    if (!days || days > 3660) throw new Error('--days (1-3660) is required');
    const expiresDays = intFlag('expires-days', null);
    const minted = await credits.mint({
      grant: { unit: UNIT, amount: days },
      label: typeof flags.label === 'string' ? flags.label : `${days} days of b1dz Pro`,
      maxRedemptions: intFlag('max', 1),
      expiresAt: expiresDays ? Date.now() + expiresDays * 86_400_000 : null,
      createdBy: typeof flags.by === 'string' ? flags.by : 'cli',
    });
    console.log(flags.json ? JSON.stringify(minted) : `${minted.code}\n  id ${minted.id}  ${days} Pro days  max ${minted.maxRedemptions}  redeem at https://b1dz.com/settings`);
    break;
  }
  case 'list':
    for (const c of await credits.list()) {
      console.log(`${c.id}  ${c.grant.amount} ${c.grant.unit}  ${c.redemptions}/${c.maxRedemptions}${c.revokedAt ? '  revoked' : ''}  ${c.label}`);
    }
    break;
  case 'revoke':
    if (!positional[0]) throw new Error('usage: revoke <codeId>');
    await credits.revoke(positional[0]);
    console.log(`revoked ${positional[0]}`);
    break;
  case 'grant': {
    if (typeof flags.user !== 'string') throw new Error('--user <uuid> is required');
    await credits.grant(flags.user, { unit: UNIT, amount: intFlag('days') }, typeof flags.source === 'string' ? flags.source : 'admin');
    console.log(`balance ${await credits.balance(flags.user, UNIT)}`);
    break;
  }
  case 'balance':
    if (typeof flags.user !== 'string') throw new Error('--user <uuid> is required');
    console.log(await credits.balance(flags.user, UNIT));
    break;
  default:
    console.error('usage: credit-codes.mjs mint|list|revoke|grant|balance (see the header of this file)');
    process.exit(1);
}
