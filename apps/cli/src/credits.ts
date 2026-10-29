/**
 * `b1dz redeem <code>`            redeem a credit code for Pro days
 * `b1dz invites`                  quota, invites sent, Pro-day balance, referral link
 * `b1dz invites create [note]`    create an invite (the link is printed once)
 *
 * Calls the hosted API with the stored session (see auth.ts).
 */
import { loadCredentials } from './auth.js';

function base(): string {
  return (process.env.B1DZ_API_URL || 'https://b1dz.com').replace(/\/$/, '');
}

async function call(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const c = loadCredentials();
  if (!c) {
    console.error('not signed in — run `b1dz login` first');
    process.exit(1);
  }
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.accessToken}` },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (res.status === 401) {
    console.error('session expired — run `b1dz login` again');
    process.exit(1);
  }
  return { ok: res.ok, status: res.status, body };
}

export async function redeem(args: string[]) {
  const code = args.join(' ').trim();
  if (!code) {
    console.error('usage: b1dz redeem <CR-XXXX-XXXX-XXXX-XXXX>');
    process.exit(1);
  }
  const r = await call('/api/credits/redeem', { method: 'POST', body: JSON.stringify({ code }) });
  if (!r.ok) {
    console.error(`✗ ${r.body.error ?? `redeem failed (${r.status})`}`);
    process.exit(1);
  }
  console.log(`✓ redeemed ${r.body.amount} Pro days — balance ${r.body.balance}`);
}

export async function invites(args: string[]) {
  if (args[0] === 'create') {
    const r = await call('/api/invites', { method: 'POST', body: JSON.stringify({ note: args.slice(1).join(' ') }) });
    if (!r.ok) {
      console.error(`✗ ${r.body.error ?? `could not create an invite (${r.status})`}`);
      process.exit(1);
    }
    console.log(`✓ invite ${r.body.code}`);
    console.log(`  ${r.body.url}`);
    console.log('  (shown once; send it to the person you are inviting)');
    return;
  }
  const r = await call('/api/invites');
  if (!r.ok) {
    console.error(`✗ ${r.body.error ?? `could not load invites (${r.status})`}`);
    process.exit(1);
  }
  const o = r.body;
  console.log(`Invites left: ${o.quota.left}/${o.quota.total}   Pro days: ${o.proDays}`);
  if (!o.canInvite && o.blockedReason) console.log(`  ${o.blockedReason}`);
  for (const i of o.invites as Array<{ note: string; status: string; bonus?: string; createdAt: number }>) {
    const when = new Date(i.createdAt).toISOString().slice(0, 10);
    console.log(`  ${when}  ${i.status.padEnd(8)} ${i.bonus ? `bonus ${i.bonus}  ` : ''}${i.note}`);
  }
  console.log(`Referral link: ${o.affiliateUrl}`);
}
