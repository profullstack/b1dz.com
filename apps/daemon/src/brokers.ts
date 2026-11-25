/**
 * Which brokers a user has linked, built from THEIR settings only.
 *
 * ALL credentials and account identifiers are read with the STRICT per-user
 * getters, never from process.env. This is the multi-tenant safety boundary:
 * a user who has not entered their own keys gets no broker, and can NEVER
 * fall back to the operator's env credentials and act on the operator's
 * account.
 *
 * Shared by the equities worker (which trades through the first linked
 * broker) and the manual order path (which lets the user pick one).
 */
import { createAlpacaConnector } from '@b1dz/source-alpaca';
import { createIbkrConnector } from '@b1dz/source-ibkr';
import { createMoomooConnector } from '@b1dz/source-moomoo';
import { createTradierConnector } from '@b1dz/source-tradier';
import { createSchwabConnector } from '@b1dz/source-schwab';
import { createTradeStationConnector } from '@b1dz/source-tradestation';
import { OAUTH_PROVIDERS, isOAuthConfigured, refreshAccessToken, type BrokerConnectorPlugin } from '@b1dz/core';
import { mergeUserSecret, type UserConfig } from './user-config.js';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000; // refresh once within 5 min of expiry

export interface LinkedBroker {
  id: string;
  label: string;
  connector: BrokerConnectorPlugin;
  paper: boolean;
  supportsFractional: boolean;
}

/** Strict per-user boolean (this user's plain blob only; never env). */
export function userBool(cfg: UserConfig, key: string, dflt: boolean): boolean {
  const raw = cfg.getUserPlain(key);
  if (raw === undefined) return dflt;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Keep every linked OAuth session alive. For each provider that issues
 * refresh tokens, if the access token is within the buffer of expiry, swap it
 * for a fresh one and persist it. Returns true if anything changed (caller
 * reloads config). Runs regardless of the trading switch.
 */
export async function refreshOauthTokens(userId: string, cfg: UserConfig): Promise<boolean> {
  const now = Date.now();
  let refreshed = false;
  for (const provider of Object.values(OAUTH_PROVIDERS)) {
    if (!provider.refreshKey || !provider.expiryKey) continue; // e.g. Alpaca tokens don't expire
    const refreshToken = cfg.getUserSecret(provider.refreshKey);
    if (!refreshToken) continue; // not linked via OAuth (this user)
    const expiresMs = Date.parse(cfg.getUserSecret(provider.expiryKey) ?? '');
    if (Number.isFinite(expiresMs) && expiresMs - now > TOKEN_REFRESH_BUFFER_MS) continue; // still fresh
    if (!isOAuthConfigured(provider)) continue; // operator hasn't registered the client
    try {
      const tok = await refreshAccessToken(provider, refreshToken);
      const patch: Record<string, string> = { [provider.tokenKey]: tok.access_token };
      if (tok.refresh_token) patch[provider.refreshKey] = tok.refresh_token;
      if (tok.expires_in) patch[provider.expiryKey] = new Date(now + tok.expires_in * 1000).toISOString();
      await mergeUserSecret(userId, patch);
      refreshed = true;
      console.log(`[brokers] refreshed ${provider.pluginId} OAuth token for ${userId.slice(0, 8)}…`);
    } catch (e) {
      console.error(`[brokers] ${provider.pluginId} token refresh failed: ${(e as Error).message}`);
    }
  }
  return refreshed;
}

/**
 * Every broker this user has linked, in the order the equities worker
 * prefers them. moomoo sits after the brokers that were here first so an
 * existing user's automated trading never moves to a newly linked account.
 */
export function linkedBrokers(cfg: UserConfig): LinkedBroker[] {
  const out: LinkedBroker[] = [];

  const oauthToken = cfg.getUserSecret('ALPACA_OAUTH_TOKEN');
  const key = cfg.getUserSecret('ALPACA_API_KEY_ID');
  const secret = cfg.getUserSecret('ALPACA_API_SECRET_KEY');
  if (oauthToken || (key && secret)) {
    const paper = userBool(cfg, 'ALPACA_PAPER', true);
    const feed = (cfg.getUserPlain('ALPACA_FEED') as 'iex' | 'sip' | undefined) ?? 'iex';
    out.push({
      id: 'alpaca',
      label: 'Alpaca',
      paper,
      supportsFractional: true,
      // OAuth bearer takes precedence over pasted key/secret.
      connector: createAlpacaConnector(oauthToken ? { accessToken: oauthToken, paper, feed } : { keyId: key, secretKey: secret, paper, feed }),
    });
  }

  // Tradier (OAuth or pasted token): whole-share orders.
  const tradierToken = cfg.getUserSecret('TRADIER_ACCESS_TOKEN');
  const tradierAcct = cfg.getUserPlain('TRADIER_ACCOUNT_ID');
  if (tradierToken && tradierAcct) {
    const sandbox = userBool(cfg, 'TRADIER_SANDBOX', true);
    out.push({
      id: 'tradier',
      label: 'Tradier',
      paper: sandbox,
      supportsFractional: false,
      connector: createTradierConnector({ accessToken: tradierToken, accountId: tradierAcct, sandbox }),
    });
  }

  // Charles Schwab (OAuth): whole-share orders, no paper.
  const schwabToken = cfg.getUserSecret('SCHWAB_ACCESS_TOKEN');
  const schwabHash = cfg.getUserPlain('SCHWAB_ACCOUNT_HASH');
  if (schwabToken && schwabHash) {
    out.push({
      id: 'schwab',
      label: 'Charles Schwab',
      paper: false,
      supportsFractional: false,
      connector: createSchwabConnector({ accessToken: schwabToken, accountHash: schwabHash }),
    });
  }

  // TradeStation (OAuth or pasted token): whole-share orders.
  const tsToken = cfg.getUserSecret('TRADESTATION_ACCESS_TOKEN');
  const tsAcct = cfg.getUserPlain('TRADESTATION_ACCOUNT_ID');
  if (tsToken && tsAcct) {
    const sim = userBool(cfg, 'TRADESTATION_SIM', true);
    out.push({
      id: 'tradestation',
      label: 'TradeStation',
      paper: sim,
      supportsFractional: false,
      connector: createTradeStationConnector({ accessToken: tsToken, accountId: tsAcct, sim }),
    });
  }

  // moomoo (OAuth 2.1): whole-share orders, live or paper account.
  const moomooToken = cfg.getUserSecret('MOOMOO_ACCESS_TOKEN');
  if (moomooToken) {
    const paper = userBool(cfg, 'MOOMOO_PAPER', true);
    out.push({
      id: 'moomoo',
      label: 'moomoo',
      paper,
      supportsFractional: false,
      connector: createMoomooConnector({ accessToken: moomooToken, accountId: cfg.getUserPlain('MOOMOO_ACCOUNT_ID'), paper }),
    });
  }

  // IBKR last (advanced; needs a running gateway).
  const base = cfg.getUserPlain('IBKR_BASE_URL');
  if (base) {
    out.push({
      id: 'ibkr',
      label: 'Interactive Brokers',
      paper: false,
      supportsFractional: true,
      connector: createIbkrConnector({ baseUrl: base, accountId: cfg.getUserPlain('IBKR_ACCOUNT_ID'), accessToken: cfg.getUserSecret('IBKR_ACCESS_TOKEN') }),
    });
  }
  return out;
}

/** The broker automated trading uses: the first one linked. */
export function primaryBroker(cfg: UserConfig): LinkedBroker | null {
  return linkedBrokers(cfg)[0] ?? null;
}
