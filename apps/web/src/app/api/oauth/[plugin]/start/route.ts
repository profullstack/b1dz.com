/**
 * GET /api/oauth/{plugin}/start
 *
 * Begins the OAuth2 authorization-code flow for a broker plugin: sets a signed
 * state cookie (CSRF) and redirects the browser to the provider's consent page.
 * The provider returns to /api/oauth/{plugin}/callback.
 *
 * A public-client provider (moomoo) also gets PKCE: the verifier waits in an
 * httpOnly cookie and only its S256 challenge goes to the provider.
 */
import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { authenticate } from '@/lib/api-auth';
import { getOAuthProvider, isOAuthConfigured, pkceChallenge } from '@/lib/oauth-providers';
import { requestOrigin } from '@/lib/credits';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ plugin: string }> }) {
  const { plugin } = await params;
  const origin = requestOrigin(req);

  const provider = getOAuthProvider(plugin);
  if (!provider) return NextResponse.redirect(`${origin}/settings?oauth=unknown&plugin=${plugin}`);

  const auth = await authenticate(req);
  if (!auth) return NextResponse.redirect(`${origin}/login?next=/settings`);

  if (!isOAuthConfigured(provider)) {
    return NextResponse.redirect(`${origin}/settings?oauth=unavailable&plugin=${plugin}`);
  }

  const state = randomBytes(24).toString('hex');
  const redirectUri = `${origin}/api/oauth/${plugin}/callback`;
  const authorize = new URL(provider.authorizeUrl);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', process.env[provider.clientIdEnv]!);
  authorize.searchParams.set('redirect_uri', redirectUri);
  if (!provider.omitScope) authorize.searchParams.set('scope', provider.scope);
  authorize.searchParams.set('state', state);

  const cookie = { httpOnly: true, secure: origin.startsWith('https'), sameSite: 'lax' as const, path: '/', maxAge: 600 };
  let verifier: string | null = null;
  if (provider.publicClient) {
    verifier = randomBytes(48).toString('base64url');
    authorize.searchParams.set('code_challenge', await pkceChallenge(verifier));
    authorize.searchParams.set('code_challenge_method', 'S256');
  }

  const res = NextResponse.redirect(authorize.toString());
  res.cookies.set(`oauth_state_${plugin}`, state, cookie);
  if (verifier) res.cookies.set(`oauth_pkce_${plugin}`, verifier, cookie);
  return res;
}
