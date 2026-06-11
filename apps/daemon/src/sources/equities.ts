/**
 * Equities worker — observe mode (M1.5 wiring).
 *
 * Arms whichever equity broker connectors the user has configured (IBKR is the
 * default broker; Alpaca is the API-key reference) and reports the live account
 * picture — market session, buying power, open positions — into source_state so
 * the dashboard can show the brokerage link works.
 *
 * It does NOT place orders yet: signal-driven equity execution is M2 and stays
 * gated behind EQUITY_TRADE_EXECUTION. Observe mode is the honest first
 * end-to-end slice: connect an account → see it reflected.
 *
 * Credentials come from user_settings via loadUserConfig (decrypted with
 * SETTINGS_ENCRYPTION_KEY); they never live as plaintext globals here.
 */
import type { SourceWorker, UserContext } from '../types.js';
import { createAlpacaConnector } from '@b1dz/source-alpaca';
import { createIbkrConnector } from '@b1dz/source-ibkr';
import { getB1dzVersion, type BrokerConnectorPlugin } from '@b1dz/core';
import { loadUserConfig, type UserConfig } from '../user-config.js';

const POLL_INTERVAL_MS = 30_000; // equities move slower than crypto ticks

/** Build the broker connectors the user has configured. */
function configuredBrokers(cfg: UserConfig): { id: string; connector: BrokerConnectorPlugin; paper: boolean }[] {
  const out: { id: string; connector: BrokerConnectorPlugin; paper: boolean }[] = [];

  const ibkrBase = cfg.getPlain('IBKR_BASE_URL');
  if (ibkrBase) {
    out.push({
      id: 'ibkr',
      paper: false,
      connector: createIbkrConnector({
        baseUrl: ibkrBase,
        accountId: cfg.getPlain('IBKR_ACCOUNT_ID'),
        accessToken: cfg.getSecret('IBKR_ACCESS_TOKEN'),
      }),
    });
  }

  const alpacaKey = cfg.getSecret('ALPACA_API_KEY_ID');
  const alpacaSecret = cfg.getSecret('ALPACA_API_SECRET_KEY');
  if (alpacaKey && alpacaSecret) {
    const paper = cfg.getBool('ALPACA_PAPER', true) ?? true;
    out.push({
      id: 'alpaca',
      paper,
      connector: createAlpacaConnector({
        keyId: alpacaKey,
        secretKey: alpacaSecret,
        paper,
        feed: (cfg.getPlain('ALPACA_FEED') as 'iex' | 'sip' | undefined) ?? 'iex',
      }),
    });
  }

  return out;
}

export const equitiesWorker: SourceWorker = {
  id: 'equities',
  pollIntervalMs: POLL_INTERVAL_MS,
  hasCredentials(payload) {
    return !!payload?.enabled;
  },
  async tick(ctx: UserContext) {
    const cfg = await loadUserConfig(ctx.userId);
    const now = new Date().toISOString();
    const version = getB1dzVersion();

    if (cfg.getBool('EQUITIES_ENABLED', false) !== true) {
      await ctx.savePayload({
        ...ctx.payload,
        enabled: false,
        daemon: { lastTickAt: now, worker: 'equities', status: 'disabled', version },
      });
      return;
    }

    const brokers = configuredBrokers(cfg);
    const report: Record<string, unknown> = {};

    await Promise.all(
      brokers.map(async ({ id, connector, paper }) => {
        try {
          const [session, buyingPowerUsd, positions] = await Promise.all([
            connector.session('SPY'),
            connector.buyingPowerUsd(),
            connector.positions(),
          ]);
          report[id] = { linked: true, paper, session, buyingPowerUsd, positions, asOf: now };
        } catch (err) {
          report[id] = { linked: false, paper, reason: (err as Error).message.slice(0, 200) };
        }
      }),
    );

    await ctx.savePayload({
      ...ctx.payload,
      enabled: true,
      brokers: report,
      configured: brokers.map((b) => b.id),
      executionEnabled: cfg.getBool('EQUITY_TRADE_EXECUTION', false) ?? false,
      daemon: {
        lastTickAt: now,
        worker: 'equities',
        status: brokers.length > 0 ? 'running' : 'idle',
        version,
      },
    });
  },
};
