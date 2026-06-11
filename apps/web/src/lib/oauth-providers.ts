/**
 * OAuth provider registry — now lives in @b1dz/core so the daemon shares it for
 * 24/7 token auto-refresh. Re-exported here so existing web imports keep working.
 */
export {
  OAUTH_PROVIDERS,
  getOAuthProvider,
  isOAuthConfigured,
  oauthStatus,
  refreshAccessToken,
  type OAuthProvider,
  type OAuthTokenResponse,
} from '@b1dz/core';
