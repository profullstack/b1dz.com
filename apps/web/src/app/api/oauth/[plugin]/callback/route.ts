/**
 * GET /api/oauth/{plugin}/callback
 *
 * Provider redirects here with ?code&state. We verify state against the cookie,
 * exchange the code for tokens (confidential client → HTTP Basic auth), and
 * merge the access token (+ refresh/expiry when present) into the user's
 * encrypted secret blob under the provider's token key — the same key the
 * daemon's connector reads. Then back to the settings page.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { authenticate } from '@/lib/api-auth';
import { getOAuthProvider, isOAuthConfigured } from '@/lib/oauth-providers';
import { mergeSecretIntoUserSettings } from '@/lib/server-crypto';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ plugin: string }> }) {
  const { plugin } = await params;
  const url = new URL(req.url);
  const origin = url.origin;
  const settings = (q: string) => NextResponse.redirect(`${origin}/settings?tab=plugins&${q}`);

  const provider = getOAuthProvider(plugin);
  if (!provider || !isOAuthConfigured(provider)) return settings(`oauth=unavailable&plugin=${plugin}`);

  const auth = await authenticate(req);
  if (!auth) return NextResponse.redirect(`${origin}/login?next=/settings`);

  const error = url.searchParams.get('error');
  if (error) return settings(`oauth=denied&plugin=${plugin}`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = req.cookies.get(`oauth_state_${plugin}`)?.value;
  if (!code || !state || !cookieState || state !== cookieState) {
    return settings(`oauth=badstate&plugin=${plugin}`);
  }

  const redirectUri = `${origin}/api/oauth/${plugin}/callback`;
  const basic = Buffer.from(`${process.env[provider.clientIdEnv]}:${process.env[provider.clientSecretEnv]}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  let tokenJson: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    const tokenRes = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      console.error(`[oauth] ${plugin} token exchange failed ${tokenRes.status}: ${text.slice(0, 200)}`);
      return settings(`oauth=exchange_failed&plugin=${plugin}`);
    }
    tokenJson = JSON.parse(text);
  } catch (e) {
    console.error(`[oauth] ${plugin} token exchange error: ${(e as Error).message}`);
    return settings(`oauth=exchange_error&plugin=${plugin}`);
  }

  if (!tokenJson.access_token) return settings(`oauth=no_token&plugin=${plugin}`);

  const patch: Record<string, string> = { [provider.tokenKey]: tokenJson.access_token };
  if (provider.refreshKey && tokenJson.refresh_token) patch[provider.refreshKey] = tokenJson.refresh_token;
  if (provider.expiryKey && tokenJson.expires_in) {
    patch[provider.expiryKey] = new Date(Date.now() + tokenJson.expires_in * 1000).toISOString();
  }

  try {
    await mergeSecretIntoUserSettings(auth.client, auth.userId, patch);
  } catch (e) {
    console.error(`[oauth] ${plugin} token store failed: ${(e as Error).message}`);
    return settings(`oauth=store_failed&plugin=${plugin}`);
  }

  const res = settings(`oauth=success&plugin=${plugin}`);
  res.cookies.delete(`oauth_state_${plugin}`);
  console.log(`[oauth] ${plugin} linked for user ${auth.userId.slice(0, 8)}…`);
  return res;
}
