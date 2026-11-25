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
  /**
   * OAuth 2.1 public client: PKCE (S256) on the authorization code, the
   * client id in the token request body, and no client secret anywhere.
   */
  publicClient?: boolean;
  /** Leave `scope` off the authorize URL (the provider picks scopes on its consent page). */
  omitScope?: boolean;
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
  moomoo: {
    pluginId: 'moomoo',
    label: 'moomoo',
    authorizeUrl: 'https://webapi.moomoo.com/oauth2/authorize/confirm',
    tokenUrl: 'https://webapi.moomoo.com/oauth2/token',
    // Granted on moomoo's consent page: quote:read trade:read trade:write.
    scope: '',
    omitScope: true,
    publicClient: true,
    clientIdEnv: 'MOOMOO_OAUTH_CLIENT_ID',
    clientSecretEnv: '',
    tokenKey: 'MOOMOO_ACCESS_TOKEN',
    // Access tokens last 2 hours; the refresh token 14 days and is not rotated.
    refreshKey: 'MOOMOO_REFRESH_TOKEN',
    expiryKey: 'MOOMOO_TOKEN_EXPIRES_AT',
  },
};

export function getOAuthProvider(pluginId: string): OAuthProvider | null {
  return OAUTH_PROVIDERS[pluginId] ?? null;
}

/** Operator has registered the app (client id, plus the secret unless it is a public client)? */
export function isOAuthConfigured(p: OAuthProvider): boolean {
  if (!process.env[p.clientIdEnv]) return false;
  return p.publicClient ? true : !!process.env[p.clientSecretEnv];
}

/** base64url(SHA-256(verifier)): the PKCE S256 challenge. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString('base64url');
}

/**
 * Headers and form body for a token request. A confidential client sends
 * HTTP Basic; a public client sends its client id in the body and no secret.
 */
export function tokenRequest(provider: OAuthProvider, params: Record<string, string>): { headers: Record<string, string>; body: string } {
  const id = process.env[provider.clientIdEnv];
  if (!id) throw new Error(`${provider.pluginId}: OAuth client not configured`);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (provider.publicClient) return { headers, body: new URLSearchParams({ ...params, client_id: id }).toString() };
  const secret = process.env[provider.clientSecretEnv];
  if (!secret) throw new Error(`${provider.pluginId}: OAuth client not configured`);
  headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  return { headers, body: new URLSearchParams(params).toString() };
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
 * Exchange a refresh token for a fresh access token (HTTP Basic for a
 * confidential client, client id in the body for a public one). Throws on non-2xx or missing access_token. Pure I/O — the
 * caller persists the result.
 */
export async function refreshAccessToken(
  provider: OAuthProvider,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokenResponse> {
  const { headers, body } = tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refreshToken });
  const res = await fetchImpl(provider.tokenUrl, { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${provider.pluginId} refresh ${res.status}: ${text.slice(0, 160)}`);
  const json = JSON.parse(text) as OAuthTokenResponse;
  if (!json.access_token) throw new Error(`${provider.pluginId} refresh: no access_token`);
  return json;
}
