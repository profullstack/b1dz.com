/**
 * GET /api/oauth/{plugin}/start
 *
 * Begins the OAuth2 authorization-code flow for a broker plugin: sets a signed
 * state cookie (CSRF) and redirects the browser to the provider's consent page.
 * The provider returns to /api/oauth/{plugin}/callback.
 */
import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { authenticate } from '@/lib/api-auth';
import { getOAuthProvider, isOAuthConfigured } from '@/lib/oauth-providers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ plugin: string }> }) {
  const { plugin } = await params;
  const origin = new URL(req.url).origin;

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
  authorize.searchParams.set('scope', provider.scope);
  authorize.searchParams.set('state', state);

  const res = NextResponse.redirect(authorize.toString());
  res.cookies.set(`oauth_state_${plugin}`, state, {
    httpOnly: true,
    secure: origin.startsWith('https'),
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  return res;
}
