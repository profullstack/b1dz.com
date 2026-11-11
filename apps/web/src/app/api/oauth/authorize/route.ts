import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/api-auth';
import { checkAuthorize, errorRedirect, issueCode, OAuthError, parseGrantLimits, siteOrigin, type AuthorizeParams } from '@/lib/mcp-oauth';
import { createAdminSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * The decision from the consent page at /oauth/authorize (the advertised
 * authorization_endpoint). JSON in, `{ redirect }` out: the page then sends the
 * browser there itself, because the site's CSP form-action would block a form
 * POST that redirects to claude.ai / chatgpt.com / localhost.
 *
 * Signed in by EITHER the cookie session (same origin only: Origin header or
 * Sec-Fetch-Site) OR `Authorization: Bearer <Supabase session access token>`,
 * which a cross-site form cannot attach. Either way: CSRF-safe.
 */
async function signedInUser(req: NextRequest): Promise<{ id: string } | null> {
  const hasBearer = /^Bearer\s+\S+$/i.test((req.headers.get('authorization') ?? '').trim());
  if (!hasBearer) {
    const origin = req.headers.get('origin');
    const sameOrigin = origin ? origin === siteOrigin() || origin === req.nextUrl.origin : req.headers.get('sec-fetch-site') === 'same-origin';
    if (!sameOrigin) return null;
  }
  const auth = await authenticate(req);
  return auth ? { id: auth.userId } : null;
}

export async function POST(req: NextRequest) {
  let body: AuthorizeParams & { approve?: unknown; trade?: unknown; budget_usd?: unknown; budget_window?: unknown };
  try {
    body = (await req.json()) as typeof body;
    if (!body || typeof body !== 'object') throw new Error();
  } catch {
    return Response.json({ error: 'invalid_request', error_description: 'Send a JSON body' }, { status: 400, headers: NO_STORE });
  }
  const approve = body.approve === true || body.approve === 'true' ? true : body.approve === false || body.approve === 'false' ? false : null;
  if (approve === null) return Response.json({ error: 'invalid_request', error_description: 'approve is required' }, { status: 400, headers: NO_STORE });

  const user = await signedInUser(req);
  if (!user) return Response.json({ error: 'unauthorized', error_description: 'Sign in to b1dz first' }, { status: 401, headers: NO_STORE });

  const admin = createAdminSupabase();
  const check = await checkAuthorize(admin, body);
  if (!check.ok) {
    return 'redirect' in check
      ? Response.json({ redirect: check.redirect }, { headers: NO_STORE })
      : Response.json({ error: check.error, error_description: check.description }, { status: 400, headers: NO_STORE });
  }
  if (!approve) {
    return Response.json({ redirect: errorRedirect(check.redirectUri, 'access_denied', 'The user denied the request', check.state) }, { headers: NO_STORE });
  }
  try {
    return Response.json({ redirect: await issueCode(admin, check, user.id, parseGrantLimits(body)) }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof OAuthError) return Response.json(err.body(), { status: err.status, headers: NO_STORE });
    console.error('[oauth] authorize failed', (err as Error).message);
    return Response.json({ error: 'server_error' }, { status: 500, headers: NO_STORE });
  }
}
