import type { NextRequest } from 'next/server';
import { authJson, siteOrigin, withAuthCookies } from '@/lib/auth-route-client';
import { checkAuthForm, signupGuard } from '@/lib/auth-form-guard';
import { saveSignupProfile, validateProfile } from '@profullstack/profile';
import { profileStore } from '@/lib/profile';
import { isPlaceholderEmail } from '@/lib/coinpay-signin';
import { INVITE_COOKIE, INVITE_META_KEY, looksLikeInviteCode } from '@/lib/credits';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as ({ email?: string; password?: string } & Record<string, unknown>) | null;
  if (!body?.email || !body?.password) return Response.json({ error: 'email + password required' }, { status: 400 });

  // Before Supabase, which would mail a confirmation to whatever address
  // was typed. A dropped submission gets the same answer a real new
  // account gets, and no mail goes out.
  const guarded = await checkAuthForm(signupGuard, 'signup', body, req.headers);
  if (guarded instanceof Response) return guarded;
  if (guarded) return Response.json({ user: null, session: null, needsEmailConfirmation: true });

  const email = body.email.trim();
  // Accounts made by Sign in with CoinPay hold placeholder addresses there.
  if (isPlaceholderEmail(email)) return Response.json({ error: 'Signup failed' }, { status: 400 });
  // The @profullstack/profile fields (first/last name required; company
  // domain, job title, LinkedIn optional) are checked before the user exists.
  const fields = { ...body, email };
  const check = validateProfile(fields);
  if (!check.ok) return Response.json({ error: 'Some fields need fixing.', errors: check.errors }, { status: 400 });
  const p = check.profile;

  // An invite from /i/<code> (cookie) or the form rides in the user's
  // metadata, so confirming the email on another device still counts it.
  const invite = [body.invite, req.cookies.get(INVITE_COOKIE)?.value].find(looksLikeInviteCode)?.trim() ?? null;

  const { response, supabase } = authJson(req, {});
  const { data, error } = await supabase.auth.signUp({
    email,
    password: body.password,
    options: {
      emailRedirectTo: `${siteOrigin(req)}/auth/callback?next=/dashboard`,
      data: {
        full_name: [p.first_name, p.last_name].filter(Boolean).join(' '),
        first_name: p.first_name,
        last_name: p.last_name,
        company_domain: p.company_domain ?? null,
        job_title: p.job_title ?? null,
        linkedin_url: p.linkedin_url ?? null,
        ...(invite ? { [INVITE_META_KEY]: invite } : {}),
      },
    },
  });

  if (error) {
    console.error('[signup] error:', error.message);
    return Response.json({ error: 'Signup failed' }, { status: 400 });
  }

  // A brand-new account has an identity; an already-registered address comes
  // back with none (or no user at all) and must not get a profile written.
  // The fields are also in user metadata, so a failed save never fails signup.
  if (data.user && (data.user.identities?.length ?? 0) > 0) {
    try {
      await saveSignupProfile(profileStore(), data.user.id, fields, { email: data.user.email });
    } catch (e) {
      console.error('[signup] profile save failed', e);
    }
  }

  // With email confirmation enabled, Supabase deliberately returns an IDENTICAL
  // response for a brand-new email and an already-registered one — no error, no
  // session, and (via supabase-js) a null user — to prevent email enumeration.
  // We therefore can't (and must not) tell the user "already registered"; we
  // just report that a confirmation email is on its way. If a session IS present
  // (confirmation disabled), the user is signed in immediately.
  const payload = {
    user: data.user ? { id: data.user.id, email: data.user.email } : null,
    session: data.session && {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    },
    needsEmailConfirmation: !data.session,
  };

  return withAuthCookies(response, payload);
}
