/**
 * Redeemable credit codes and scarce invites (server only).
 *
 * - A credit code (@profullstack/redeem-credits, `CR-XXXX-...`) grants Pro
 *   days (unit `pro_days`). An operator mints it (apps/web/scripts/credit-codes.mjs)
 *   and hands it to someone; they redeem it on /settings ("Have a code?"),
 *   with POST /api/credits/redeem, or `b1dz redeem <code>`.
 * - An invite (@profullstack/affiliates, `INV-XXXX-...`) is scarce: every
 *   account gets INVITE_QUOTA once it is INVITE_MIN_ACCOUNT_AGE_DAYS old.
 *   When a NEW account joins on one, both people get INVITE_BONUS_PRO_DAYS,
 *   but only after the abuse checks in bonusVerdict() pass.
 *
 * b1dz sells no plan today (every store plugin is free), so the Pro-day
 * balance lives in one place only: the credit_ledger these modules keep.
 * Nothing else tracks Pro, so there is no second balance to drift.
 *
 * Abuse rules (b1dz has had scripted signup waves; see auth-form-guard.ts):
 * the invitee's email must be confirmed, not a throwaway inbox, and not the
 * inviter's own mailbox under a +tag or Gmail dots; both sides must not
 * connect from the same network (X-Real-IP only, which nginx sets from the
 * TCP peer; never CF-Connecting-IP / True-Client-IP / X-Forwarded-For); an
 * inviter is paid for at most INVITE_BONUS_MONTHLY_CAP invites per 30 days;
 * an account accepts one invite, and only while it is new.
 *
 * Clients are built lazily so env vars are read at runtime.
 */
import { createHash } from 'node:crypto';
import { Credits, supabaseStore as creditStore, type MintedCode } from '@profullstack/redeem-credits';
import { Affiliates, supabaseStore as affiliateStore } from '@profullstack/affiliates';
import { isValid as mailIsValid } from 'mailchecker';

export const PRO_DAYS_UNIT = 'pro_days';
export const INVITE_QUOTA = 3;
export const INVITE_BONUS_PRO_DAYS = 7;
export const INVITE_MIN_ACCOUNT_AGE_DAYS = 7;
export const INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS = 7;
export const INVITE_TTL_DAYS = 30;
export const INVITE_BONUS_MONTHLY_CAP = 10;
/** Cookie /i/<code> sets so the code survives the trip through signup. */
export const INVITE_COOKIE = 'b1dz_invite';
/** user_metadata key the signup route stores the invite under (another browser still counts). */
export const INVITE_META_KEY = 'invite_code';

const DAY_MS = 86_400_000;

export interface AuthUser {
  id: string;
  email: string | null;
  confirmed: boolean;
  createdAt: number;
  inviteCode: string | null;
}

export type BonusStatus = 'pending' | 'granted' | 'denied';
export interface BonusRow {
  invite_id: string;
  side: 'inviter' | 'invitee';
  user_id: string;
  status: BonusStatus;
  reason: string | null;
  days: number;
  updated_at: string;
}

export interface SideStore {
  getUser(id: string): Promise<AuthUser | null>;
  getBonus(inviteId: string, side: 'inviter' | 'invitee'): Promise<BonusRow | null>;
  putBonus(row: BonusRow): Promise<void>;
  bonusesFor(userId: string): Promise<BonusRow[]>;
  getNetwork(inviteId: string): Promise<{ inviter_ip_hash: string | null; invitee_ip_hash: string | null } | null>;
  putNetwork(inviteId: string, patch: { inviter_ip_hash?: string | null; invitee_ip_hash?: string | null }): Promise<void>;
}

export interface CreditDeps {
  credits: Credits;
  affiliates: Affiliates;
  side: SideStore;
  now: () => number;
  ipSalt: string;
}

// ── Supabase wiring ────────────────────────────────────────────────────────

type Db = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: (fn: string, args?: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  auth: { admin: { getUserById: (id: string) => Promise<{ data: { user: any } | null; error: unknown }> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export function supabaseSideStore(db: Db): SideStore {
  return {
    async getUser(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const { data, error } = await db.auth.admin.getUserById(id);
      if (error || !data?.user) return null;
      const u = data.user as {
        id: string; email?: string | null; email_confirmed_at?: string | null; confirmed_at?: string | null;
        created_at?: string; user_metadata?: Record<string, unknown> | null;
      };
      const meta = u.user_metadata ?? {};
      return {
        id: u.id,
        email: u.email ?? null,
        confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
        createdAt: u.created_at ? new Date(u.created_at).getTime() : 0,
        inviteCode: typeof meta[INVITE_META_KEY] === 'string' ? (meta[INVITE_META_KEY] as string) : null,
      };
    },
    async getBonus(inviteId, side) {
      const { data, error } = await db.from('invite_bonuses').select('*').eq('invite_id', inviteId).eq('side', side).maybeSingle();
      if (error) throw new Error(`invite_bonuses read: ${error.message}`);
      return (data as BonusRow | null) ?? null;
    },
    async putBonus(row) {
      const { error } = await db.from('invite_bonuses').upsert(row, { onConflict: 'invite_id,side' });
      if (error) throw new Error(`invite_bonuses write: ${error.message}`);
    },
    async bonusesFor(userId) {
      const { data, error } = await db.from('invite_bonuses').select('*').eq('user_id', userId);
      if (error) throw new Error(`invite_bonuses list: ${error.message}`);
      return (data as BonusRow[] | null) ?? [];
    },
    async getNetwork(inviteId) {
      const { data, error } = await db.from('invite_network').select('inviter_ip_hash, invitee_ip_hash').eq('invite_id', inviteId).maybeSingle();
      if (error) throw new Error(`invite_network read: ${error.message}`);
      return data ?? null;
    },
    async putNetwork(inviteId, patch) {
      const { error } = await db.from('invite_network').upsert({ invite_id: inviteId, ...patch }, { onConflict: 'invite_id' });
      if (error) throw new Error(`invite_network write: ${error.message}`);
    },
  };
}

const env = (name: string) => process.env[name] ?? '';

export function buildCreditDeps(db: Db, now: () => number = Date.now): CreditDeps {
  return {
    credits: new Credits(creditStore(db as never), { now }),
    affiliates: new Affiliates(affiliateStore(db as never), {
      now,
      defaultQuota: INVITE_QUOTA,
      inviteTtlMs: INVITE_TTL_DAYS * DAY_MS,
    }),
    side: supabaseSideStore(db),
    now,
    ipSalt: env('FORM_GUARD_SECRET') || env('SUPABASE_SECRET_KEY') || 'b1dz-invites',
  };
}

let _deps: CreditDeps | undefined;
export async function getCreditDeps(): Promise<CreditDeps> {
  if (_deps) return _deps;
  const { createAdminSupabase } = await import('@/lib/supabase');
  _deps = buildCreditDeps(createAdminSupabase() as unknown as Db);
  return _deps;
}
export function setCreditDepsForTest(deps: CreditDeps | undefined) {
  _deps = deps;
}

// ── Request helpers ────────────────────────────────────────────────────────

/**
 * The caller's address as nginx saw it. Only X-Real-IP: nginx overwrites it
 * with $remote_addr (the PROXY-protocol peer), so a client cannot choose it.
 * Every other forwarding header is client-controlled and ignored here.
 */
export function trustedIp(headers: Headers): string | null {
  return headers.get('x-real-ip')?.trim() || null;
}

export function ipHash(ip: string | null, salt: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

/** Absolute links from the request host, never a localhost default. */
export function requestOrigin(req: { headers: Headers; url: string }): string {
  const fixed = process.env.NEXT_PUBLIC_SITE_URL;
  if (fixed && !/localhost|127\.0\.0\.1/.test(fixed)) return fixed.replace(/\/$/, '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host && /^[a-z0-9.-]+(:\d+)?$/i.test(host)) {
    const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
    return `${proto}://${host}`;
  }
  return new URL(req.url).origin;
}

export function inviteUrl(origin: string, code: string) {
  return `${origin.replace(/\/$/, '')}/i/${encodeURIComponent(code)}`;
}

/** Shape check before a code is stored in a cookie or user metadata. */
export function looksLikeInviteCode(input: unknown): input is string {
  if (typeof input !== 'string') return false;
  const s = input.trim();
  return s.length >= 12 && s.length <= 40 && /^[a-z0-9 -]+$/i.test(s);
}

// ── Mailbox rules ──────────────────────────────────────────────────────────

/** One mailbox, however it is spelled: lowercase, no +tag, no Gmail dots. */
export function canonicalMailbox(email: string): string {
  const [rawLocal, rawDomain = ''] = email.trim().toLowerCase().split('@');
  let domain = rawDomain;
  let local = rawLocal.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** Throwaway inbox (mailchecker's list) or not an email at all. */
export function isDisposableEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  return !mailIsValid(email);
}

// ── Credit codes ───────────────────────────────────────────────────────────

export type RedeemFailure = 'invalid' | 'expired' | 'used_up' | 'already_redeemed' | 'revoked';
export const REDEEM_MESSAGES: Record<RedeemFailure, string> = {
  invalid: 'That code is not valid. Check it and try again.',
  expired: 'That code has expired.',
  used_up: 'That code has already been used.',
  already_redeemed: 'You have already redeemed that code.',
  revoked: 'That code is no longer valid.',
};

export async function proDaysBalance(userId: string, deps?: CreditDeps): Promise<number> {
  const d = deps ?? (await getCreditDeps());
  return d.credits.balance(userId, PRO_DAYS_UNIT);
}

export async function redeemCreditCode(
  userId: string,
  code: string,
  deps?: CreditDeps,
): Promise<
  | { ok: true; unit: string; amount: number; balance: number }
  | { ok: false; reason: RedeemFailure; message: string }
> {
  const d = deps ?? (await getCreditDeps());
  const r = await d.credits.redeem(String(code ?? '').slice(0, 64), userId);
  if (!r.ok) return { ok: false, reason: r.reason, message: REDEEM_MESSAGES[r.reason] };
  return { ok: true, unit: r.grant.unit, amount: r.grant.amount, balance: await d.credits.balance(userId, r.grant.unit) };
}

export async function mintCreditCode(
  o: { days: number; label?: string; maxRedemptions?: number; expiresAt?: number | null; createdBy?: string },
  deps?: CreditDeps,
): Promise<MintedCode> {
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > 3660) {
    throw new TypeError('days must be a whole number from 1 to 3660');
  }
  const d = deps ?? (await getCreditDeps());
  return d.credits.mint({
    grant: { unit: PRO_DAYS_UNIT, amount: o.days },
    label: o.label ?? `${o.days} days of b1dz Pro`,
    maxRedemptions: o.maxRedemptions ?? 1,
    expiresAt: o.expiresAt ?? null,
    createdBy: o.createdBy,
  });
}

// ── Invites ────────────────────────────────────────────────────────────────

export class InviteError extends Error {
  constructor(message: string, public status: number, public reason: string) {
    super(message);
  }
}

function ageDays(createdAt: number, now: number) {
  return createdAt ? (now - createdAt) / DAY_MS : 0;
}

/** Why an account may not send invites yet, or null when it may. */
function senderBlock(user: AuthUser | null, now: number): { reason: string; message: string; unlocksAt?: string } | null {
  if (!user) return { reason: 'no_account', message: 'Account not found.' };
  if (!user.confirmed) return { reason: 'unconfirmed', message: 'Confirm your email address to send invites.' };
  if (isDisposableEmail(user.email)) return { reason: 'disposable', message: 'Accounts on a throwaway inbox cannot send invites.' };
  if (ageDays(user.createdAt, now) < INVITE_MIN_ACCOUNT_AGE_DAYS) {
    return {
      reason: 'too_new',
      message: `Invites unlock once your account is ${INVITE_MIN_ACCOUNT_AGE_DAYS} days old.`,
      unlocksAt: new Date(user.createdAt + INVITE_MIN_ACCOUNT_AGE_DAYS * DAY_MS).toISOString(),
    };
  }
  return null;
}

export type InviteStatus = 'open' | 'used' | 'expired' | 'revoked';
export interface InviteView {
  id: string;
  note: string;
  createdAt: number;
  expiresAt: number | null;
  usedAt: number | null;
  status: InviteStatus;
  bonus?: BonusStatus | null;
  bonusReason?: string | null;
}

export async function inviteOverview(userId: string, deps?: CreditDeps) {
  const d = deps ?? (await getCreditDeps());
  const now = d.now();
  // Settle anything this user is owed first (cheap: bounded by the quota).
  await settleInvitesFor(userId, d);
  const [user, quota, raw, bonuses, balance, affiliateCode] = await Promise.all([
    d.side.getUser(userId),
    d.affiliates.quota(userId),
    d.affiliates.invites(userId),
    d.side.bonusesFor(userId),
    d.credits.balance(userId, PRO_DAYS_UNIT),
    d.affiliates.affiliateCode(userId),
  ]);
  const byInvite = new Map(bonuses.filter((b) => b.side === 'inviter').map((b) => [b.invite_id, b]));
  const invites: InviteView[] = raw.map((i) => ({
    id: i.id,
    note: i.note,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    usedAt: i.usedAt,
    status: i.usedBy ? 'used' : i.revokedAt ? 'revoked' : i.expiresAt !== null && now >= i.expiresAt ? 'expired' : 'open',
    ...(i.usedBy ? { bonus: byInvite.get(i.id)?.status ?? 'pending', bonusReason: byInvite.get(i.id)?.reason ?? null } : {}),
  }));
  const block = senderBlock(user, now);
  const invitedBy = await d.affiliates.invitedBy(userId);
  const own = bonuses.find((b) => b.side === 'invitee') ?? null;
  return {
    quota,
    invites,
    canInvite: !block,
    blockedReason: block?.message ?? null,
    unlocksAt: block?.unlocksAt ?? null,
    bonusDays: INVITE_BONUS_PRO_DAYS,
    proDays: balance,
    affiliateCode,
    joinedOnInvite: Boolean(invitedBy),
    joinBonus: own ? { status: own.status, reason: own.reason } : null,
    canAcceptInvite: !invitedBy && !!user && ageDays(user.createdAt, now) <= INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS,
  };
}

export async function createInvite(userId: string, note: string, ip: string | null, deps?: CreditDeps) {
  const d = deps ?? (await getCreditDeps());
  const block = senderBlock(await d.side.getUser(userId), d.now());
  if (block) throw new InviteError(block.message, 403, block.reason);
  let invite;
  try {
    invite = await d.affiliates.createInvite(userId, String(note ?? '').slice(0, 200));
  } catch (err) {
    if (/no invites left/i.test(String((err as Error)?.message))) throw new InviteError('You have no invites left.', 409, 'no_invites_left');
    throw err;
  }
  await d.side.putNetwork(invite.id, { inviter_ip_hash: ipHash(ip, d.ipSalt) });
  return invite;
}

export async function revokeInvite(userId: string, inviteId: string, deps?: CreditDeps) {
  const d = deps ?? (await getCreditDeps());
  const mine = (await d.affiliates.invites(userId)).find((i) => i.id === inviteId);
  if (!mine) throw new InviteError('Invite not found.', 404, 'not_found');
  if (mine.usedBy) throw new InviteError('That invite has already been used.', 409, 'used');
  await d.affiliates.revokeInvite(inviteId);
}

export const ACCEPT_MESSAGES: Record<string, string> = {
  invalid: 'That invite code is not valid.',
  expired: 'That invite has expired.',
  used: 'That invite has already been used.',
  self: 'You cannot use your own invite.',
  revoked: 'That invite was withdrawn.',
  already_invited: 'Your account has already joined on an invite.',
  not_new: `Invites are for new accounts (${INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS} days old or less).`,
  no_account: 'Account not found.',
};

/**
 * Spend an invite on a new account and record who invited whom. The bonus
 * is decided by settleInviteBonus(), right after and again later (email
 * confirmation, visits to /invites), so a pending check can still pass.
 */
export async function acceptInvite(userId: string, code: string, ip: string | null, deps?: CreditDeps) {
  const d = deps ?? (await getCreditDeps());
  const fail = (reason: string) => ({ ok: false as const, reason, message: ACCEPT_MESSAGES[reason] ?? reason });
  const user = await d.side.getUser(userId);
  if (!user) return fail('no_account');
  if (ageDays(user.createdAt, d.now()) > INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS) return fail('not_new');
  if (await d.affiliates.invitedBy(userId)) return fail('already_invited');
  const r = await d.affiliates.redeemInvite(String(code ?? '').slice(0, 64), userId);
  if (!r.ok) return fail(r.reason);
  await d.side.putNetwork(r.inviteId, { invitee_ip_hash: ipHash(ip, d.ipSalt) });
  const settled = await settleInviteBonus(userId, d);
  return { ok: true as const, inviteId: r.inviteId, bonusDays: INVITE_BONUS_PRO_DAYS, bonus: settled };
}

export function inviteSource(inviteId: string, side: 'inviter' | 'invitee') {
  return `invite:${inviteId}:${side}`;
}

/**
 * The abuse checks. 'deny' is final (the pair is the same person or a
 * throwaway); 'hold' is re-checked later (unconfirmed email, monthly cap).
 */
export function bonusVerdict(input: {
  invitee: AuthUser | null;
  inviter: AuthUser | null;
  network: { inviter_ip_hash: string | null; invitee_ip_hash: string | null } | null;
  inviterGrantsLast30d: number;
}): { action: 'grant' } | { action: 'hold' | 'deny'; reason: string } {
  const { invitee, inviter, network } = input;
  if (!invitee || !inviter) return { action: 'deny', reason: 'account_missing' };
  if (!invitee.confirmed) return { action: 'hold', reason: 'email_unconfirmed' };
  if (isDisposableEmail(invitee.email)) return { action: 'deny', reason: 'disposable_email' };
  if (isDisposableEmail(inviter.email)) return { action: 'deny', reason: 'inviter_disposable_email' };
  if (invitee.email && inviter.email && canonicalMailbox(invitee.email) === canonicalMailbox(inviter.email)) {
    return { action: 'deny', reason: 'same_mailbox' };
  }
  if (network?.inviter_ip_hash && network.invitee_ip_hash && network.inviter_ip_hash === network.invitee_ip_hash) {
    return { action: 'deny', reason: 'same_network' };
  }
  if (input.inviterGrantsLast30d >= INVITE_BONUS_MONTHLY_CAP) return { action: 'hold', reason: 'monthly_cap' };
  return { action: 'grant' };
}

function isDuplicate(err: unknown) {
  return /duplicate key|unique|23505/i.test(String((err as Error)?.message ?? err));
}

async function grantOnce(d: CreditDeps, userId: string, source: string): Promise<boolean> {
  const done = (await d.credits.history(userId, PRO_DAYS_UNIT)).some((e) => e.kind === 'grant' && e.source === source);
  if (done) return false;
  try {
    await d.credits.grant(userId, { unit: PRO_DAYS_UNIT, amount: INVITE_BONUS_PRO_DAYS }, source);
    return true;
  } catch (err) {
    if (isDuplicate(err)) return false; // a concurrent settle won (unique index)
    throw err;
  }
}

/** Decide (or re-decide) the bonus for the invite this account joined on. Idempotent. */
export async function settleInviteBonus(inviteeId: string, deps?: CreditDeps): Promise<{ status: 'none' | BonusStatus; reason?: string }> {
  const d = deps ?? (await getCreditDeps());
  const inviterId = await d.affiliates.invitedBy(inviteeId);
  if (!inviterId) return { status: 'none' };
  const invite = (await d.affiliates.invites(inviterId)).find((i) => i.usedBy === inviteeId);
  if (!invite) return { status: 'none' };

  const [mine, theirs] = await Promise.all([d.side.getBonus(invite.id, 'invitee'), d.side.getBonus(invite.id, 'inviter')]);
  if (mine?.status !== 'pending' && mine && theirs && theirs.status !== 'pending') {
    return { status: mine.status, reason: mine.reason ?? undefined };
  }

  const now = d.now();
  const [invitee, inviter, network, inviterRows] = await Promise.all([
    d.side.getUser(inviteeId),
    d.side.getUser(inviterId),
    d.side.getNetwork(invite.id),
    d.side.bonusesFor(inviterId),
  ]);
  const inviterGrantsLast30d = inviterRows.filter(
    (b) => b.side === 'inviter' && b.status === 'granted' && now - new Date(b.updated_at).getTime() < 30 * DAY_MS,
  ).length;
  const verdict = bonusVerdict({ invitee, inviter, network, inviterGrantsLast30d });
  const stamp = new Date(now).toISOString();

  if (verdict.action !== 'grant') {
    const status: BonusStatus = verdict.action === 'deny' ? 'denied' : 'pending';
    if (verdict.action === 'deny') console.warn('[invites] bonus denied', { inviteId: invite.id, reason: verdict.reason });
    // The invitee's own bonus is not held by the inviter's monthly cap.
    if (verdict.reason === 'monthly_cap') {
      if (!mine || mine.status === 'pending') {
        await grantOnce(d, inviteeId, inviteSource(invite.id, 'invitee'));
        await d.side.putBonus({ invite_id: invite.id, side: 'invitee', user_id: inviteeId, status: 'granted', reason: null, days: INVITE_BONUS_PRO_DAYS, updated_at: stamp });
      }
      if (!theirs || theirs.status === 'pending') {
        await d.side.putBonus({ invite_id: invite.id, side: 'inviter', user_id: inviterId, status, reason: verdict.reason, days: 0, updated_at: stamp });
      }
      return { status: 'granted' };
    }
    for (const [side, uid, row] of [['invitee', inviteeId, mine], ['inviter', inviterId, theirs]] as const) {
      if (row?.status === 'granted' || row?.status === 'denied') continue;
      await d.side.putBonus({ invite_id: invite.id, side, user_id: uid, status, reason: verdict.reason, days: 0, updated_at: stamp });
    }
    return { status, reason: verdict.reason };
  }

  for (const [side, uid, row] of [['invitee', inviteeId, mine], ['inviter', inviterId, theirs]] as const) {
    if (row?.status === 'granted' || row?.status === 'denied') continue;
    await grantOnce(d, uid, inviteSource(invite.id, side));
    await d.side.putBonus({ invite_id: invite.id, side, user_id: uid, status: 'granted', reason: null, days: INVITE_BONUS_PRO_DAYS, updated_at: stamp });
  }
  return { status: 'granted' };
}

/** Settle as invitee and for every used invite this user sent (bounded by the quota). */
export async function settleInvitesFor(userId: string, deps?: CreditDeps) {
  const d = deps ?? (await getCreditDeps());
  const jobs: Promise<unknown>[] = [settleInviteBonus(userId, d)];
  for (const inv of await d.affiliates.invites(userId)) {
    if (inv.usedBy) jobs.push(settleInviteBonus(inv.usedBy, d));
  }
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === 'rejected') console.error('[invites] settle failed', r.reason);
  }
}

/**
 * After a sign-in (email confirmation link or password login): accept the
 * invite carried in user metadata (set at signup, so another browser still
 * counts) or the /i/<code> cookie, record ?ref= attribution for a new
 * account, then settle. Never throws: sign-in must not fail on this.
 */
export async function afterSignIn(
  userId: string,
  opts: { cookieInvite?: string | null; ref?: string | null; ip: string | null },
  deps?: CreditDeps,
): Promise<void> {
  try {
    const d = deps ?? (await getCreditDeps());
    const user = await d.side.getUser(userId);
    if (!user) return;
    const isNew = ageDays(user.createdAt, d.now()) <= INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS;
    const code = [user.inviteCode, opts.cookieInvite].find(looksLikeInviteCode) ?? null;
    if (code && isNew && !(await d.affiliates.invitedBy(userId))) {
      const r = await acceptInvite(userId, code, opts.ip, d);
      if (!r.ok) console.log('[invites] invite at sign-in not accepted:', r.reason);
    }
    if (opts.ref && isNew && /^[A-Z0-9]{4,32}$/i.test(opts.ref)) {
      await d.affiliates.attribute(opts.ref, userId).catch(() => undefined);
    }
    await settleInvitesFor(userId, d);
  } catch (err) {
    console.error('[invites] afterSignIn failed', err);
  }
}
