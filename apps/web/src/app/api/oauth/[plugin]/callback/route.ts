/**
 * GET /api/oauth/{plugin}/callback
 *
 * Provider redirects here with ?code&state. We verify state against the cookie,
 * exchange the code for tokens (HTTP Basic for a confidential client; client id
 * plus the PKCE verifier for a public one), and
 * seal the access token (+ refresh/expiry when present) to the user's OAuth
 * inbox public key (user_settings.secret_inbox). The server can write the
 * token but can never read it back: the user's unlocked browser (or the
 * daemon during an unlocked session) opens the inbox and merges it into the
 * sealed secret blob under the provider's token key. Then back to settings.
 *
 * A user who has not set a passphrase yet is sent back with oauth=needs_passphrase.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { authenticate } from '@/lib/api-auth';
import { getOAuthProvider, isOAuthConfigured, tokenRequest } from '@/lib/oauth-providers';
import { requestOrigin } from '@/lib/credits';
import { sealToInbox } from '@b1dz/core/sealed-secrets';
import { loadSettingsRow, rowInbox, rowSeal, type Sb } from '@/lib/settings-row';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ plugin: string }> }) {
  const { plugin } = await params;
  const url = new URL(req.url);
  const origin = requestOrigin(req);
  const settings = (q: string) => NextResponse.redirect(`${origin}/settings?tab=plugins&${q}`);

  const provider = getOAuthProvider(plugin);
  if (!provider || !isOAuthConfigured(provider)) return settings(`oauth=unavailable&plugin=${plugin}`);

  const auth = await authenticate(req);
  if (!auth) return NextResponse.redirect(`${origin}/login?next=/settings`);

  let seal;
  let inboxNow;
  try {
    const row = await loadSettingsRow(auth.client, auth.userId);
    seal = rowSeal(row);
    inboxNow = rowInbox(row);
  } catch {
    return settings(`oauth=store_failed&plugin=${plugin}`);
  }
  if (!seal) return settings(`oauth=needs_passphrase&plugin=${plugin}`);

  const error = url.searchParams.get('error');
  if (error) return settings(`oauth=denied&plugin=${plugin}`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = req.cookies.get(`oauth_state_${plugin}`)?.value;
  if (!code || !state || !cookieState || state !== cookieState) {
    return settings(`oauth=badstate&plugin=${plugin}`);
  }

  const redirectUri = `${origin}/api/oauth/${plugin}/callback`;
  const grant: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirectUri };
  if (provider.publicClient) {
    const verifier = req.cookies.get(`oauth_pkce_${plugin}`)?.value;
    if (!verifier) return settings(`oauth=badstate&plugin=${plugin}`);
    grant.code_verifier = verifier;
  }
  const tokenReq = tokenRequest(provider, grant);

  let tokenJson: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    const tokenRes = await fetch(provider.tokenUrl, { method: 'POST', headers: tokenReq.headers, body: tokenReq.body });
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
    const entry = await sealToInbox(seal.inbox_public_key, patch, auth.userId);
    const { error: upErr } = await (auth.client as unknown as Sb).from('user_settings').upsert(
      { user_id: auth.userId, secret_inbox: [...inboxNow, entry].slice(-20), updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
    if (upErr) throw new Error(upErr.message);
  } catch (e) {
    console.error(`[oauth] ${plugin} token store failed: ${(e as Error).message}`);
    return settings(`oauth=store_failed&plugin=${plugin}`);
  }

  const res = settings(`oauth=success&plugin=${plugin}`);
  res.cookies.delete(`oauth_state_${plugin}`);
  res.cookies.delete(`oauth_pkce_${plugin}`);
  console.log(`[oauth] ${plugin} linked for user ${auth.userId.slice(0, 8)}…`);
  return res;
}
