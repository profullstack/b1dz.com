import { describe, expect, it } from 'vitest';
import { Credits, memoryStore as creditMemory } from '@profullstack/redeem-credits';
import { Affiliates, memoryStore as affMemory } from '@profullstack/affiliates';
import {
  acceptInvite,
  afterSignIn,
  canonicalMailbox,
  createInvite,
  INVITE_BONUS_MONTHLY_CAP,
  INVITE_BONUS_PRO_DAYS,
  isDisposableEmail,
  mintCreditCode,
  PRO_DAYS_UNIT,
  redeemCreditCode,
  settleInviteBonus,
  trustedIp,
  type AuthUser,
  type BonusRow,
  type CreditDeps,
  type SideStore,
} from './credits';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 26, 12);

function fakeSide(users: AuthUser[]): SideStore & { users: Map<string, AuthUser>; bonuses: Map<string, BonusRow> } {
  const byId = new Map(users.map((u) => [u.id, u]));
  const bonuses = new Map<string, BonusRow>();
  const network = new Map<string, { inviter_ip_hash: string | null; invitee_ip_hash: string | null }>();
  return {
    users: byId,
    bonuses,
    async getUser(id) { return byId.get(id) ?? null; },
    async getBonus(inviteId, side) { return bonuses.get(`${inviteId}:${side}`) ?? null; },
    async putBonus(row) { bonuses.set(`${row.invite_id}:${row.side}`, { ...row }); },
    async bonusesFor(userId) { return [...bonuses.values()].filter((b) => b.user_id === userId); },
    async getNetwork(inviteId) { return network.get(inviteId) ?? null; },
    async putNetwork(inviteId, patch) {
      const cur = network.get(inviteId) ?? { inviter_ip_hash: null, invitee_ip_hash: null };
      network.set(inviteId, { ...cur, ...patch });
    },
  };
}

function user(id: string, email: string, ageDays: number, confirmed = true): AuthUser {
  return { id, email, confirmed, createdAt: NOW - ageDays * DAY, inviteCode: null };
}

function deps(users: AuthUser[]) {
  const now = () => NOW;
  const side = fakeSide(users);
  const d: CreditDeps = {
    credits: new Credits(creditMemory(), { now }),
    affiliates: new Affiliates(affMemory(), { now, defaultQuota: 3 }),
    side,
    now,
    ipSalt: 'test',
  };
  return { d, side };
}

describe('credit codes', () => {
  it('grants Pro days once per user and refuses a used code', async () => {
    const { d } = deps([]);
    const { code } = await mintCreditCode({ days: 30 }, d);
    const r = await redeemCreditCode('u1', code, d);
    expect(r).toMatchObject({ ok: true, unit: PRO_DAYS_UNIT, amount: 30, balance: 30 });
    expect(await redeemCreditCode('u1', code, d)).toMatchObject({ ok: false, reason: 'already_redeemed' });
    expect(await redeemCreditCode('u2', code, d)).toMatchObject({ ok: false, reason: 'used_up' });
    expect(await redeemCreditCode('u2', 'CR-0000-0000-0000-0000', d)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects silly day counts', async () => {
    const { d } = deps([]);
    await expect(mintCreditCode({ days: 0 }, d)).rejects.toThrow();
    await expect(mintCreditCode({ days: 1.5 }, d)).rejects.toThrow();
  });
});

describe('invites', () => {
  const alice = () => user('alice', 'alice@profullstack.com', 30);
  const bob = () => user('bob', 'bob@example.org', 1);

  it('pays both sides once after the checks pass, one invite per account', async () => {
    const { d } = deps([alice(), bob(), user('carol', 'carol@profullstack.com', 30)]);
    const inv = await createInvite('alice', 'for bob', '1.1.1.1', d);
    const r = await acceptInvite('bob', inv.code, '2.2.2.2', d);
    expect(r).toMatchObject({ ok: true, bonus: { status: 'granted' } });
    expect(await d.credits.balance('alice', PRO_DAYS_UNIT)).toBe(INVITE_BONUS_PRO_DAYS);
    expect(await d.credits.balance('bob', PRO_DAYS_UNIT)).toBe(INVITE_BONUS_PRO_DAYS);

    // settling again never pays twice
    await settleInviteBonus('bob', d);
    expect(await d.credits.balance('alice', PRO_DAYS_UNIT)).toBe(INVITE_BONUS_PRO_DAYS);

    // a second invite for the same account is refused and stays unused
    const other = await createInvite('carol', '', '3.3.3.3', d);
    expect(await acceptInvite('bob', other.code, '2.2.2.2', d)).toMatchObject({ ok: false, reason: 'already_invited' });
    expect(await d.credits.balance('carol', PRO_DAYS_UNIT)).toBe(0);
  });

  it('denies the same mailbox under +tags and Gmail dots', async () => {
    const { d } = deps([user('a', 'j.doe@gmail.com', 30), user('b', 'jdoe+b1dz@googlemail.com', 0)]);
    const inv = await createInvite('a', '', '1.1.1.1', d);
    const r = await acceptInvite('b', inv.code, '2.2.2.2', d);
    expect(r).toMatchObject({ ok: true, bonus: { status: 'denied', reason: 'same_mailbox' } });
    expect(await d.credits.balance('a', PRO_DAYS_UNIT)).toBe(0);
    expect(await d.credits.balance('b', PRO_DAYS_UNIT)).toBe(0);
  });

  it('denies a throwaway inbox', async () => {
    const { d } = deps([alice(), user('t', 'x@mailinator.com', 0)]);
    const inv = await createInvite('alice', '', '1.1.1.1', d);
    expect(await acceptInvite('t', inv.code, '2.2.2.2', d)).toMatchObject({ bonus: { status: 'denied', reason: 'disposable_email' } });
  });

  it('denies both sides on one network (nginx X-Real-IP)', async () => {
    const { d } = deps([alice(), bob()]);
    const inv = await createInvite('alice', '', '9.9.9.9', d);
    expect(await acceptInvite('bob', inv.code, '9.9.9.9', d)).toMatchObject({ bonus: { status: 'denied', reason: 'same_network' } });
  });

  it('holds the bonus until the email is confirmed', async () => {
    const { d, side } = deps([alice(), user('bob', 'bob@example.org', 0, false)]);
    const inv = await createInvite('alice', '', '1.1.1.1', d);
    expect(await acceptInvite('bob', inv.code, '2.2.2.2', d)).toMatchObject({ bonus: { status: 'pending', reason: 'email_unconfirmed' } });
    side.users.get('bob')!.confirmed = true;
    expect(await settleInviteBonus('bob', d)).toEqual({ status: 'granted' });
    expect(await d.credits.balance('alice', PRO_DAYS_UNIT)).toBe(INVITE_BONUS_PRO_DAYS);
  });

  it('caps what an inviter earns per 30 days but still pays the new account', async () => {
    const { d, side } = deps([alice(), bob()]);
    for (let i = 0; i < INVITE_BONUS_MONTHLY_CAP; i++) {
      await side.putBonus({ invite_id: `old${i}`, side: 'inviter', user_id: 'alice', status: 'granted', reason: null, days: 7, updated_at: new Date(NOW - DAY).toISOString() });
    }
    const inv = await createInvite('alice', '', '1.1.1.1', d);
    await acceptInvite('bob', inv.code, '2.2.2.2', d);
    expect(await d.credits.balance('bob', PRO_DAYS_UNIT)).toBe(INVITE_BONUS_PRO_DAYS);
    expect(await d.credits.balance('alice', PRO_DAYS_UNIT)).toBe(0);
    expect(side.bonuses.get(`${inv.id}:inviter`)).toMatchObject({ status: 'pending', reason: 'monthly_cap' });
  });

  it('keeps new accounts from sending and old accounts from accepting', async () => {
    const { d } = deps([user('new', 'new@example.org', 2), user('old', 'old@example.org', 60), alice()]);
    await expect(createInvite('new', '', null, d)).rejects.toMatchObject({ reason: 'too_new' });
    const inv = await createInvite('alice', '', null, d);
    expect(await acceptInvite('old', inv.code, null, d)).toMatchObject({ ok: false, reason: 'not_new' });
  });

  it('accepts the invite from signup metadata at first sign-in', async () => {
    const { d, side } = deps([alice(), bob()]);
    const inv = await createInvite('alice', '', '1.1.1.1', d);
    side.users.get('bob')!.inviteCode = inv.code;
    await afterSignIn('bob', { cookieInvite: null, ref: null, ip: '2.2.2.2' }, d);
    expect(await d.affiliates.invitedBy('bob')).toBe('alice');
    expect(await d.credits.balance('bob', PRO_DAYS_UNIT)).toBe(INVITE_BONUS_PRO_DAYS);
  });
});

describe('helpers', () => {
  it('reads only X-Real-IP, never client-set forwarding headers', () => {
    const h = new Headers({ 'cf-connecting-ip': '6.6.6.6', 'true-client-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6' });
    expect(trustedIp(h)).toBeNull();
    h.set('x-real-ip', '5.5.5.5');
    expect(trustedIp(h)).toBe('5.5.5.5');
  });

  it('canonicalises mailboxes', () => {
    expect(canonicalMailbox('J.Doe+x@Gmail.com')).toBe('jdoe@gmail.com');
    expect(canonicalMailbox('j.doe+x@example.org')).toBe('j.doe@example.org');
  });

  it('flags throwaway inboxes', () => {
    expect(isDisposableEmail('a@mailinator.com')).toBe(true);
    expect(isDisposableEmail('a@profullstack.com')).toBe(false);
    expect(isDisposableEmail(null)).toBe(true);
  });
});
