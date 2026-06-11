/**
 * OAuth2 provider registry for broker plugins.
 *
 * Only the bearer-token equity brokers support OAuth authorization-code login
 * here. DEX connectors (wallet keys) and the CEX venues (API-key only; Coinbase
 * Advanced Trade uses keys, not OAuth) are paste-creds only.
 *
 * The operator registers an OAuth app per provider and sets the client
 * id/secret env vars below; the redirect URI to register is
 *   {origin}/api/oauth/{pluginId}/callback
 * Until both env vars are set, the UI shows OAuth as unavailable and users
 * paste credentials instead.
 *
 * On success the callback writes the access token (and refresh token / expiry
 * when provided) into the user's encrypted secret blob under `tokenKey` — the
 * SAME key the daemon's connector reads, so OAuth and paste-creds are
 * interchangeable downstream.
 *
 * NOTE: tokens are stored as-issued; automatic refresh is a follow-up. Endpoint
 * URLs should be verified against each provider's current docs before go-live.
 */
export interface OAuthProvider {
  pluginId: string;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** user_settings secret key the access token is written to (connector reads it). */
  tokenKey: string;
  /** optional secret keys for refresh token + expiry. */
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

/** Operator has registered the app (both env vars present)? */
export function isOAuthConfigured(p: OAuthProvider): boolean {
  return !!process.env[p.clientIdEnv] && !!process.env[p.clientSecretEnv];
}

/** Status map for the UI: which plugins support OAuth and whether it's wired. */
export function oauthStatus(): Record<string, { supported: boolean; configured: boolean }> {
  const out: Record<string, { supported: boolean; configured: boolean }> = {};
  for (const [id, p] of Object.entries(OAUTH_PROVIDERS)) {
    out[id] = { supported: true, configured: isOAuthConfigured(p) };
  }
  return out;
}
