import { afterEach, describe, expect, it } from 'vitest';
import { linkedBrokers, primaryBroker } from './brokers.js';
import type { UserConfig } from './user-config.js';

function cfg(secret: Record<string, string>, plain: Record<string, string> = {}): UserConfig {
  return {
    userId: 'u',
    getSecret: (k) => secret[k] ?? plain[k] ?? process.env[k],
    getPlain: (k) => plain[k] ?? process.env[k],
    getUserSecret: (k) => secret[k],
    getUserPlain: (k) => plain[k],
    getNumber: () => undefined,
    getBool: () => undefined,
  };
}

afterEach(() => {
  delete process.env.ALPACA_API_KEY_ID;
  delete process.env.ALPACA_API_SECRET_KEY;
  delete process.env.MOOMOO_ACCESS_TOKEN;
});

describe('linkedBrokers', () => {
  it('never falls back to the operator env for a user with no keys', () => {
    process.env.ALPACA_API_KEY_ID = 'operator';
    process.env.ALPACA_API_SECRET_KEY = 'operator';
    process.env.MOOMOO_ACCESS_TOKEN = 'operator';
    expect(linkedBrokers(cfg({}))).toEqual([]);
    expect(primaryBroker(cfg({}))).toBeNull();
  });

  it('links Alpaca and moomoo, paper by default', () => {
    const list = linkedBrokers(cfg({ ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's', MOOMOO_ACCESS_TOKEN: 't' }));
    expect(list.map((b) => [b.id, b.paper, b.supportsFractional])).toEqual([
      ['alpaca', true, true],
      ['moomoo', true, false],
    ]);
    expect(list[1].connector.manifest.capabilities).toContain('feature:paper');
  });

  it('honours the live switches per broker', () => {
    const list = linkedBrokers(cfg({ ALPACA_OAUTH_TOKEN: 'o', MOOMOO_ACCESS_TOKEN: 't' }, { ALPACA_PAPER: 'false', MOOMOO_PAPER: 'false', MOOMOO_ACCOUNT_ID: '281756476993717999' }));
    expect(list.map((b) => [b.id, b.paper])).toEqual([
      ['alpaca', false],
      ['moomoo', false],
    ]);
  });

  it('keeps automated trading on the broker that was linked first', () => {
    // moomoo is added after the older brokers, so linking it never moves the bot.
    const c = cfg({ TRADIER_ACCESS_TOKEN: 't', MOOMOO_ACCESS_TOKEN: 'm' }, { TRADIER_ACCOUNT_ID: 'A1' });
    expect(primaryBroker(c)?.id).toBe('tradier');
    expect(primaryBroker(cfg({ MOOMOO_ACCESS_TOKEN: 'm' }))?.id).toBe('moomoo');
  });
});
