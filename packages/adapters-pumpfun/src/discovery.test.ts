import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PumpFunDiscoveryAdapter, type PumpFunRawCoin } from './discovery.js';

const NOW = 1_700_000_000_000;

function rawCoin(overrides: Partial<PumpFunRawCoin>): PumpFunRawCoin {
  return {
    mint: `mint-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Coin',
    symbol: 'TEST',
    created_timestamp: NOW - 10 * 60_000, // 10 min ago
    usd_market_cap: 10_000,
    complete: false,
    ...overrides,
  };
}

function makeFetchMock(response: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } }));
}

describe('PumpFunDiscoveryAdapter', () => {
  beforeEach(() => {
    delete process.env.PUMPFUN_ENABLE_SCRAPE;
  });

  it('returns empty array when scraping is not explicitly enabled', async () => {
    const adapter = new PumpFunDiscoveryAdapter({
      fetchImpl: makeFetchMock([rawCoin({})]),
      now: () => NOW,
    });
    const result = await adapter.discover();
    expect(result).toEqual([]);
  });

  it('reports unhealthy when disabled', async () => {
    const adapter = new PumpFunDiscoveryAdapter({ now: () => NOW });
    const h = await adapter.health();
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.reason).toMatch(/PUMPFUN_ENABLE_SCRAPE/);
  });

  it('fetches and parses coins when enabled', async () => {
    const fetchMock = makeFetchMock([
      rawCoin({ mint: 'a', symbol: 'A', created_timestamp: NOW - 10 * 60_000 }),
      rawCoin({ mint: 'b', symbol: 'B', created_timestamp: NOW - 5 * 60_000 }),
    ]);
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: fetchMock,
      now: () => NOW,
    });
    const result = await adapter.discover();
    expect(result).toHaveLength(2);
    expect(result[0]!.mint).toBe('a');
    expect(result[0]!.lifecycle).toBe('new_launch');
    expect(result[0]!.flags.isNewLaunch).toBe(true);
    // Verify the request targeted the expected endpoint with correct params.
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.pathname).toBe('/coins');
    expect(url.searchParams.get('sort')).toBe('created_timestamp');
    expect(url.searchParams.get('order')).toBe('DESC');
  });

  it('filters by minMarketCapUsd', async () => {
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: makeFetchMock([
        rawCoin({ mint: 'cheap', usd_market_cap: 500 }),
        rawCoin({ mint: 'mid', usd_market_cap: 5_000 }),
        rawCoin({ mint: 'rich', usd_market_cap: 50_000 }),
      ]),
      now: () => NOW,
    });
    const result = await adapter.discover({ minMarketCapUsd: 10_000 });
    expect(result.map((t) => t.mint)).toEqual(['rich']);
  });

  it('filters by maxAgeMinutes', async () => {
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: makeFetchMock([
        rawCoin({ mint: 'fresh', created_timestamp: NOW - 5 * 60_000 }),
        rawCoin({ mint: 'old', created_timestamp: NOW - 2 * 60 * 60_000 }),
      ]),
      now: () => NOW,
    });
    const result = await adapter.discover({ maxAgeMinutes: 30 });
    expect(result.map((t) => t.mint)).toEqual(['fresh']);
  });

  it('filters by lifecycleAllowlist', async () => {
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: makeFetchMock([
        rawCoin({ mint: 'curve-1h', created_timestamp: NOW - 2 * 60 * 60_000 }),
        rawCoin({ mint: 'grad', complete: true, raydium_pool: 'p', created_timestamp: NOW - 24 * 60 * 60_000 }),
        rawCoin({ mint: 'launch', created_timestamp: NOW - 10 * 60_000 }),
      ]),
      now: () => NOW,
    });
    const onlyLaunches = await adapter.discover({ lifecycleAllowlist: ['new_launch'] });
    expect(onlyLaunches.map((t) => t.mint)).toEqual(['launch']);

    const onlyGraduated = await adapter.discover({ lifecycleAllowlist: ['external_pool', 'pumpswap'] });
    expect(onlyGraduated.map((t) => t.mint)).toEqual(['grad']);
  });

  it('exposes virtual reserves for pre-migration tokens', async () => {
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: makeFetchMock([
        rawCoin({
          mint: 'bonding',
          virtual_sol_reserves: 30_000_000_000,
          virtual_token_reserves: 1_073_000_000_000_000,
        }),
      ]),
      now: () => NOW,
    });
    const [token] = await adapter.discover();
    expect(token!.virtualSolReserves).toBe(30_000_000_000);
    expect(token!.virtualTokenReserves).toBe(1_073_000_000_000_000);
  });

  it('returns [] when upstream returns non-200', async () => {
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: makeFetchMock({ error: 'down' }, 503),
      now: () => NOW,
    });
    expect(await adapter.discover()).toEqual([]);
  });

  it('returns [] when upstream returns malformed JSON', async () => {
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: vi.fn(async () => new Response('not json', { status: 200 })),
      now: () => NOW,
    });
    expect(await adapter.discover()).toEqual([]);
  });

  it('returns [] when upstream returns a non-array body', async () => {
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: makeFetchMock({ not: 'an array' }),
      now: () => NOW,
    });
    expect(await adapter.discover()).toEqual([]);
  });

  it('reports healthy when scraping is enabled and fetch succeeds', async () => {
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: makeFetchMock([rawCoin({})]),
      now: () => NOW,
    });
    const h = await adapter.health();
    expect(h.ok).toBe(true);
  });

  it('VenueAdapter quote methods return null / false (Pump.fun is discovery-only)', async () => {
    const adapter = new PumpFunDiscoveryAdapter({ enableScrape: true, now: () => NOW });
    expect(await adapter.supports()).toBe(false);
    expect(await adapter.quote({ pair: 'SOL-USDC', side: 'sell', amountIn: '1' })).toBeNull();
  });

  it('respects the pageLimit option when building the request', async () => {
    const fetchMock = makeFetchMock([]);
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: fetchMock,
      now: () => NOW,
      pageLimit: 12,
    });
    await adapter.discover();
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get('limit')).toBe('12');
  });

  it('clamps pageLimit to [1, 50]', async () => {
    const fetchMock = makeFetchMock([]);
    const adapter = new PumpFunDiscoveryAdapter({
      enableScrape: true,
      fetchImpl: fetchMock,
      now: () => NOW,
      pageLimit: 500,
    });
    await adapter.discover();
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get('limit')).toBe('50');
  });
});
