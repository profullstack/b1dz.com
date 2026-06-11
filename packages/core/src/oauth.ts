/**
 * OAuth2 provider registry for broker plugins — shared by the web app (login
 * flow) and the daemon (24/7 token auto-refresh).
 *
 * Only the bearer-token equity brokers support OAuth here. The access token is
 * written to `tokenKey` in the user's encrypted secret blob — the SAME key the
 * connector reads — so OAuth and pasted credentials are interchangeable. When a
 * provider issues refresh tokens, `refreshKey`/`expiryKey` are also stored and
 * the daemon refreshes the access token before it expires.
 *
 * Endpoint URLs/scopes are documented but should be verified against each
 * provider's live OAuth app before go-live.
 */
export interface OAuthProvider {
  pluginId: string;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Secret key the access token is written to (the connector reads it). */
  tokenKey: string;
  /** Secret keys for the refresh token + access-token expiry (when issued). */
  refreshKey?: string;
  expiryKey?: string;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  alpaca: {
    pluginId: 'alpaca',
    label: 'Alpaca',
    authorizeUrl: 'https://app.alpaca.markets/oauth/authorize',
    tokenUrl: 'https://api.alpaca.markets/oauth/token',
    scope: 'account:write trading data',
    clientIdEnv: 'ALPACA_OAUTH_CLIENT_ID',
    clientSecretEnv: 'ALPACA_OAUTH_CLIENT_SECRET',
    tokenKey: 'ALPACA_OAUTH_TOKEN',
    // Alpaca OAuth access tokens do not expire → no refresh.
  },
  tradier: {
    pluginId: 'tradier',
    label: 'Tradier',
    authorizeUrl: 'https://api.tradier.com/v1/oauth/authorize',
    tokenUrl: 'https://api.tradier.com/v1/oauth/accesstoken',
    scope: 'read,write,trade,market',
    clientIdEnv: 'TRADIER_OAUTH_CLIENT_ID',
    clientSecretEnv: 'TRADIER_OAUTH_CLIENT_SECRET',
    tokenKey: 'TRADIER_ACCESS_TOKEN',
    refreshKey: 'TRADIER_REFRESH_TOKEN',
    expiryKey: 'TRADIER_TOKEN_EXPIRES_AT',
  },
  schwab: {
    pluginId: 'schwab',
    label: 'Charles Schwab',
    authorizeUrl: 'https://api.schwabapi.com/v1/oauth/authorize',
    tokenUrl: 'https://api.schwabapi.com/v1/oauth/token',
    scope: 'readonly',
    clientIdEnv: 'SCHWAB_OAUTH_CLIENT_ID',
    clientSecretEnv: 'SCHWAB_OAUTH_CLIENT_SECRET',
    tokenKey: 'SCHWAB_ACCESS_TOKEN',
    refreshKey: 'SCHWAB_REFRESH_TOKEN',
    expiryKey: 'SCHWAB_TOKEN_EXPIRES_AT',
  },
  tradestation: {
    pluginId: 'tradestation',
    label: 'TradeStation',
    authorizeUrl: 'https://signin.tradestation.com/authorize',
    tokenUrl: 'https://signin.tradestation.com/oauth/token',
    scope: 'openid profile MarketData ReadAccount Trade offline_access',
    clientIdEnv: 'TRADESTATION_OAUTH_CLIENT_ID',
    clientSecretEnv: 'TRADESTATION_OAUTH_CLIENT_SECRET',
    tokenKey: 'TRADESTATION_ACCESS_TOKEN',
    refreshKey: 'TRADESTATION_REFRESH_TOKEN',
    expiryKey: 'TRADESTATION_TOKEN_EXPIRES_AT',
  },
};

export function getOAuthProvider(pluginId: string): OAuthProvider | null {
  return OAUTH_PROVIDERS[pluginId] ?? null;
}

/** Operator has registered the app (both client env vars present)? */
export function isOAuthConfigured(p: OAuthProvider): boolean {
  return !!process.env[p.clientIdEnv] && !!process.env[p.clientSecretEnv];
}

/** Status map for the settings UI. */
export function oauthStatus(): Record<string, { supported: boolean; configured: boolean }> {
  const out: Record<string, { supported: boolean; configured: boolean }> = {};
  for (const [id, p] of Object.entries(OAUTH_PROVIDERS)) {
    out[id] = { supported: true, configured: isOAuthConfigured(p) };
  }
  return out;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Exchange a refresh token for a fresh access token (confidential client →
 * HTTP Basic auth). Throws on non-2xx or missing access_token. Pure I/O — the
 * caller persists the result.
 */
export async function refreshAccessToken(
  provider: OAuthProvider,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokenResponse> {
  const id = process.env[provider.clientIdEnv];
  const secret = process.env[provider.clientSecretEnv];
  if (!id || !secret) throw new Error(`${provider.pluginId}: OAuth client not configured`);
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetchImpl(provider.tokenUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${provider.pluginId} refresh ${res.status}: ${text.slice(0, 160)}`);
  const json = JSON.parse(text) as OAuthTokenResponse;
  if (!json.access_token) throw new Error(`${provider.pluginId} refresh: no access_token`);
  return json;
}
