import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JupiterFeed, __resetJupiterCacheForTests } from './jupiter.js';

describe('JupiterFeed', () => {
  const fetchMock = vi.fn();
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    fetchMock.mockReset();
    __resetJupiterCacheForTests();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { (globalThis as { fetch: typeof fetch }).fetch = origFetch; });

  it('parses the v3 response (keyed by mint) and returns bid/ask with 10-bps spread', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { usdPrice: 0.00002345, liquidity: 1e6, decimals: 5 },
        'So11111111111111111111111111111111111111112':  { usdPrice: 175.50, liquidity: 7e8, decimals: 9 },
      }),
    });
    const feed = new JupiterFeed();
    const snap = await feed.snapshot('BONK-USD');
    expect(snap).not.toBeNull();
    expect(snap!.exchange).toBe('jupiter');
    expect(snap!.bid).toBeCloseTo(0.00002345 * 0.9995, 10);
    expect(snap!.ask).toBeCloseTo(0.00002345 * 1.0005, 10);
  });

  it('returns null when the token is missing from the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        'So11111111111111111111111111111111111111112': { usdPrice: 175, liquidity: 7e8 },
      }),
    });
    const feed = new JupiterFeed();
    expect(await feed.snapshot('BONK-USD')).toBeNull();
  });

  it('returns null when the fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const feed = new JupiterFeed();
    expect(await feed.snapshot('SOL-USD')).toBeNull();
  });

  it('orderBook returns null — AMMs don\'t publish books', async () => {
    const feed = new JupiterFeed();
    expect(await feed.orderBook('SOL-USD')).toBeNull();
  });
});
