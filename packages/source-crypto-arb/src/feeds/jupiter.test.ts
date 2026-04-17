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

  it('parses the /price/v2 response into bid/ask with a 10-bps spread', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          BONK: { id: 'BONK', type: 'derivedPrice', price: '0.00002345' },
          SOL: { id: 'SOL', type: 'derivedPrice', price: '175.50' },
        },
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
      json: async () => ({ data: { SOL: { id: 'SOL', type: 'derivedPrice', price: '175' } } }),
    });
    const feed = new JupiterFeed();
    expect(await feed.snapshot('UNKNOWNCOIN-USD')).toBeNull();
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
