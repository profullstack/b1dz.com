import { createFormGuard, type FormGuard } from '@profullstack/form-guard';

/**
 * Guards for the two public forms that make Supabase send an email to an
 * address the submitter types in: signup (confirmation mail) and forgot
 * password (reset mail).
 *
 * Both were being driven by a script from ~55 rotating Tor/proxy addresses
 * (Sep 27 – Oct 2026: ~70 confirmations and ~60 resets to strangers'
 * inboxes, no resulting sign-in). It POSTs straight at the API, so the
 * primary check is a token minted when the page renders: a request that
 * never rendered the page cannot produce one. Around it: honeypot, a
 * fill-time floor, and a per-address rate limit.
 *
 * The page that mints a token and the route that checks it must share one
 * of these instances; a `binding` or field-name mismatch would reject every
 * genuine submission without saying why.
 *
 * The secret never reaches the browser, so it falls back to
 * SUPABASE_SECRET_KEY, which these routes already cannot work without.
 */
const secret = process.env.FORM_GUARD_SECRET ?? process.env.SUPABASE_SECRET_KEY ?? '';

if (!secret) {
  console.warn('auth-form-guard: no FORM_GUARD_SECRET or SUPABASE_SECRET_KEY set — signup and password reset are UNPROTECTED');
}

function make(binding: string): FormGuard | null {
  if (!secret) return null;
  return createFormGuard({
    secret,
    binding,
    // A person types an email (and a password) in a few seconds at most.
    minAgeMs: 1_500,
    rateLimit: { max: 5, windowMs: 60 * 60 * 1000 },
    // Set FORM_GUARD_ENFORCE=0 to score without blocking, if a real
    // person ever reports being turned away.
    requireToken: process.env.FORM_GUARD_ENFORCE !== '0',
  });
}

export const signupGuard = make('b1dz:signup');
export const resetGuard = make('b1dz:reset-password');

/** Props a server page hands its client form. */
export interface GuardProps {
  token: string | null;
  tokenName: string | null;
  honeypotName: string | null;
}

export async function guardProps(guard: FormGuard | null): Promise<GuardProps> {
  if (!guard) return { token: null, tokenName: null, honeypotName: null };
  const token = await guard.issue();
  const f = guard.fields(token);
  return { token, tokenName: f.token.name, honeypotName: f.honeypot.name };
}

/**
 * The script sends its User-Agent wrapped in literal double quotes
 * (`"Mozilla/5.0 ..."`), which no browser does. Cheap, exact, and it stops
 * the current run even if it learns to scrape a token from the page.
 */
function quotedUserAgent(headers: Headers): boolean {
  return (headers.get('user-agent') ?? '').trimStart().startsWith('"');
}

/**
 * The caller's address as nginx saw it. nginx sets X-Real-IP from the TCP
 * peer, so it cannot be forged. form-guard's own lookup prefers
 * CF-Connecting-IP / True-Client-IP, which nginx passes through untouched:
 * a script sending a fresh fake one per request would get a fresh rate
 * limit bucket each time.
 */
function realIp(headers: Headers): string | null {
  return headers.get('x-real-ip')?.trim() || headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

/**
 * Runs the guard. Returns `null` when the submission may proceed, or
 * `{ drop: true }` for a submission to swallow silently (answer as if it
 * succeeded, send nothing), or a ready refusal Response.
 *
 * Dropping rather than refusing is deliberate: a bot that is told why it
 * failed learns what to send next time. The exception is the quoted
 * User-Agent, which is answered 403: that is certain, and a 4xx is what
 * ThreatCrush reads from the nginx log to ban the address
 * (rule `quoted-user-agent`, as with `auth-throttle-429` for the 429s).
 */
export async function checkAuthForm(
  guard: FormGuard | null,
  route: string,
  fields: Record<string, unknown>,
  headers: Headers,
): Promise<Response | { drop: true } | null> {
  const ip = realIp(headers);
  if (quotedUserAgent(headers)) {
    console.warn(`[${route}] refused: quoted user-agent ip=${ip ?? '?'}`);
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!guard) return null;
  const verdict = await guard.check({ fields, headers, ip });
  if (verdict.allow) return null;
  if (verdict.action === 'drop') {
    console.warn(`[${route}] dropped (${verdict.reason}) ip=${verdict.ip ?? '?'}`);
    return { drop: true };
  }
  if (verdict.action === 'limited') {
    console.warn(`[${route}] rate limited ip=${verdict.ip ?? '?'}`);
    return Response.json(
      { error: 'Too many attempts from this connection. Please try again later.' },
      { status: 429, headers: verdict.retryAfterMs ? { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) } : {} },
    );
  }
  return Response.json(
    { error: 'That took too long, or came through too quickly. Please reload the page and try again.' },
    { status: 400 },
  );
}
