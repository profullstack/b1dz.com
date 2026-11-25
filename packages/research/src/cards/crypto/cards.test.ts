/** The crypto dashboards, search and a few cards end to end against canned responses. No network. */
import { describe, expect, it } from 'vitest';
import { Http } from '../../http.js';
import { Registry, createContext, interleave } from '../../registry.js';
import type { StatsBlock, TableBlock } from '../../types.js';
import { derivatives } from '../derivatives/index.js';
import { registry } from '../index.js';
import { SEARCH_COINS, crypto, cryptoDashboards, cryptoSearch, searchCoin } from './index.js';
import { loadMarket } from './market-data.js';

function fakeHttp(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const { status = 200, body } = handler(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { http: new Http({ fetch: impl, hostGapMs: 0 }), calls };
}

const NOW = new Date('2026-11-25T04:00:00Z');

describe('crypto dashboards', () => {
  it('fills the Crypto group with ten dashboards and no dangling cards', () => {
    const reg = registry();
    expect(reg.danglingCards()).toEqual([]);
    const group = reg.dashboards.filter((d) => d.group === 'Crypto');
    expect(group.map((d) => d.id)).toEqual(['crypto-markets', 'crypto', 'crypto-derivatives', 'defi', 'stablecoins', 'bitcoin', 'ethereum', 'crypto-equities', 'crypto-exchanges', 'crypto-news']);
    // The dashboard that existed before keeps its id and its old tabs.
    expect(reg.dashboard('crypto')?.tabs.map((t) => t.id)).toEqual(expect.arrayContaining(['spot', 'book', 'options', 'volatility', 'funding']));
  });

  it('places every crypto card, and every Deribit crypto card, on a tab', () => {
    const placed = new Set(cryptoDashboards.flatMap((d) => d.tabs.flatMap((t) => t.cards)));
    for (const c of crypto.cards) expect(placed.has(c.id), c.id).toBe(true);
    for (const c of derivatives.cards.filter((x) => x.id.startsWith('derivatives.crypto-'))) expect(placed.has(c.id), c.id).toBe(true);
    for (const d of cryptoDashboards) {
      expect(new Set(d.tabs.map((t) => t.id)).size, d.id).toBe(d.tabs.length);
      for (const t of d.tabs) expect(t.cards.length, `${d.id}/${t.id}`).toBeGreaterThan(0);
    }
  });

  it('gives every card an id in the area, a source, a description and defaults for its params', () => {
    const ids = crypto.cards.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of crypto.cards) {
      expect(c.id.startsWith('crypto.'), c.id).toBe(true);
      expect(c.source.length, c.id).toBeGreaterThan(0);
      expect(c.description?.length ?? 0, c.id).toBeGreaterThan(20);
      expect(`${c.title} ${c.description}`.includes('—'), c.id).toBe(false);
      for (const p of c.params ?? []) {
        expect(p.default, `${c.id}.${p.name}`).toBeTruthy();
        if (p.choices) expect(p.choices, `${c.id}.${p.name}`).toContain(p.default);
      }
    }
  });
});

describe('crypto search', () => {
  it('resolves a coin from a symbol, a pair or a name', () => {
    expect(searchCoin('sol')).toEqual({ symbol: 'SOL', name: 'Solana' });
    expect(searchCoin('SOL-USD')).toEqual({ symbol: 'SOL', name: 'Solana' });
    expect(searchCoin('ethusdt')).toEqual({ symbol: 'ETH', name: 'Ethereum' });
    expect(searchCoin('Bitcoin')).toEqual({ symbol: 'BTC', name: 'Bitcoin' });
    expect(searchCoin('chain')?.symbol).toBe('LINK');
    expect(searchCoin('bit')).toBeNull();
    expect(searchCoin('aapl')).toBeNull();
    expect(searchCoin('s')).toBeNull();
    expect(new Set(SEARCH_COINS.map((c) => c[0])).size).toBe(SEARCH_COINS.length);
  });

  it('offers the coin dashboards with the coin as the symbol', () => {
    const hits = cryptoSearch('sol');
    expect(hits.map((h) => `${h.dashboard}/${h.tab}`)).toEqual(['crypto/spot', 'crypto/venues', 'crypto-derivatives/funding', 'crypto-derivatives/open-interest', 'crypto-news/coin']);
    expect(hits.every((h) => h.params?.symbol === 'SOL-USD')).toBe(true);
    expect(hits[0].label).toBe('Solana (SOL): profile, price and supply');
  });

  it('adds the chain dashboards for bitcoin and ether and the stablecoin dashboard for stablecoins', () => {
    const btc = cryptoSearch('bitcoin').map((h) => `${h.dashboard}/${h.tab ?? ''}`);
    expect(btc).toEqual(expect.arrayContaining(['crypto/spot', 'bitcoin/', 'crypto-equities/etfs']));
    const eth = cryptoSearch('ETH').map((h) => `${h.dashboard}/${h.tab ?? ''}`);
    expect(eth).toEqual(expect.arrayContaining(['crypto/spot', 'ethereum/', 'crypto-equities/etfs']));
    const usdt = cryptoSearch('usdt').map((h) => `${h.dashboard}/${h.tab ?? ''}`);
    expect(usdt).toEqual(['crypto/spot', 'stablecoins/supply', 'crypto-news/coin']);
  });

  it('jumps to a tab for a topic and stays quiet otherwise', () => {
    expect(cryptoSearch('funding rate')[0]).toMatchObject({ dashboard: 'crypto-derivatives', tab: 'funding' });
    expect(cryptoSearch('tvl')[0]).toMatchObject({ dashboard: 'defi', tab: 'tvl' });
    expect(cryptoSearch('stablecoin')[0]).toMatchObject({ dashboard: 'stablecoins', tab: 'supply' });
    expect(cryptoSearch('mempool')[0]).toMatchObject({ dashboard: 'bitcoin', tab: 'fees' });
    expect(cryptoSearch('halving')[0]).toMatchObject({ dashboard: 'bitcoin', tab: 'supply' });
    expect(cryptoSearch('gwei')[0]).toMatchObject({ dashboard: 'ethereum', tab: 'gas' });
    expect(cryptoSearch('layer 2')[0]).toMatchObject({ dashboard: 'ethereum', tab: 'l2' });
    expect(cryptoSearch('aapl')).toEqual([]);
    expect(cryptoSearch('nvda options')).toEqual([]);
    expect(cryptoSearch(' ')).toEqual([]);
  });

  it('shows every area\'s best match before any area\'s second', async () => {
    expect(interleave([[1, 2, 3], [], [4], [5, 6]])).toEqual([1, 4, 5, 2, 6, 3]);
    const hit = (label: string) => ({ kind: 'security' as const, label, dashboard: 'x' });
    const reg = new Registry([
      { cards: [], dashboards: [], search: async () => [hit('stock 1'), hit('stock 2'), hit('stock 3')] },
      { cards: [], dashboards: [], search: async () => [hit('coin 1'), hit('coin 2')] },
    ]);
    const ctx = createContext({ http: fakeHttp(() => ({ body: '' })).http, env: {} });
    expect((await reg.search(ctx, 'sol')).map((h) => h.label)).toEqual(['stock 1', 'coin 1', 'stock 2', 'coin 2', 'stock 3']);
  });
});

describe('crypto cards on canned responses', () => {
  const paprikaTickers = [
    { id: 'btc-bitcoin', name: 'Bitcoin', symbol: 'BTC', rank: 1, total_supply: 20117069, max_supply: 21000000, quotes: { USD: { price: 60000, volume_24h: 2e10, market_cap: 1.2e12, percent_change_1h: 0.1, percent_change_24h: -2, percent_change_7d: -8, percent_change_30d: -25, percent_change_1y: -30, ath_price: 126000, ath_date: '2025-10-06T19:00:40Z', percent_from_price_ath: -52.4 } } },
    { id: 'eth-ethereum', name: 'Ethereum', symbol: 'ETH', rank: 2, total_supply: 120000000, max_supply: 0, quotes: { USD: { price: 1700, volume_24h: 7e9, market_cap: 2.04e11, percent_change_24h: -3, percent_change_7d: -8, percent_change_30d: -28 } } },
    { id: 'usdt-tether', name: 'Tether', symbol: 'USDT', rank: 3, total_supply: 174000000000, max_supply: 0, quotes: { USD: { price: 1, volume_24h: 4e10, market_cap: 1.74e11, percent_change_24h: 0, percent_change_7d: 0, percent_change_30d: 0 } } },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `c${i}-coin`, name: `Coin ${i}`, symbol: `C${i}`, rank: 4 + i, total_supply: 1e9, max_supply: 0, quotes: { USD: { price: 1 + i, volume_24h: 5e6, market_cap: 1e9 * (10 - i), percent_change_24h: i - 4, percent_change_7d: 2 * (i - 4), percent_change_30d: 3 * (i - 4) } } })),
  ];

  it('falls back to CoinGecko when CoinPaprika refuses, and says so', async () => {
    const gecko = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, symbol: `g${i}`, name: `G ${i}`, current_price: 10 + i, market_cap: 1e9, market_cap_rank: i + 1, total_volume: 1e6 }));
    const { http, calls } = fakeHttp((url) => (url.includes('coinpaprika') ? { status: 429, body: 'slow down' } : { body: gecko }));
    const m = await loadMarket(createContext({ http, env: {}, now: () => NOW }));
    expect(m.source).toBe('CoinGecko');
    expect(m.coins).toHaveLength(12);
    expect(m.skipped[0]).toMatch(/^CoinPaprika unavailable/);
    expect(calls.filter((c) => c.includes('coingecko'))).toHaveLength(1);
  });

  it('computes dominance and the stablecoin share on the global card', async () => {
    const { http } = fakeHttp((url) => (url.endsWith('/global') ? { body: { market_cap_usd: 2e12, volume_24h_usd: 1e11, bitcoin_dominance_percentage: 60, cryptocurrencies_number: 11395, market_cap_ath_value: 4e12, market_cap_ath_date: '2025-10-05T10:10:00Z', market_cap_change_24h: -1.9, volume_24h_change_24h: -30, last_updated: 1795579524 } } : { body: paprikaTickers }));
    const out = await registry().run(createContext({ http, env: {}, now: () => NOW }), 'crypto.global');
    const stats = Object.fromEntries((out.blocks[0] as StatsBlock).items.map((i) => [i.label, i.value]));
    expect(stats['Total market cap']).toBe(2e12);
    expect(stats['Bitcoin dominance']).toBe(60);
    expect(stats['Ether dominance']).toBeCloseTo(10.2, 9);
    expect(stats['Stablecoin share']).toBeCloseTo(8.7, 9);
    expect(stats['From record']).toBe(-50);
    expect(out.source).toBe('CoinPaprika');
    expect(out.asOf).toBe('2026-11-25T04:05Z');
  });

  it('counts down to the halving from the chain height', async () => {
    const { http } = fakeHttp((url) => (url.endsWith('/blocks/tip/height') ? { body: '977462' } : { body: { timeAvg: 600_000, remainingBlocks: 298 } }));
    const out = await registry().run(createContext({ http, env: {}, now: () => NOW }), 'crypto.btc-halving');
    const stats = Object.fromEntries((out.blocks[0] as StatsBlock).items.map((i) => [i.label, i.value]));
    expect(stats['Next halving at block']).toBe(1_050_000);
    expect(stats['Blocks to go']).toBe(72_538);
    expect(stats['Block reward now (BTC)']).toBe(3.125);
    expect(stats['Block reward after (BTC)']).toBe(1.5625);
    expect(stats['Date at 10-minute blocks']).toBe(NOW.getTime() + 72_538 * 600_000);
    expect(stats['New coins per day (BTC)']).toBe(450);
    const schedule = (out.blocks[1] as TableBlock).rows;
    expect(schedule[schedule.length - 1]).toMatchObject({ event: 'Next halving', height: 1_050_000, subsidy: 1.5625 });
  });

  it('compares the exchanges that answer and names the ones that do not', async () => {
    const { http } = fakeHttp((url) => {
      if (url.includes('coinbase')) return { body: { ask: '100.1', bid: '99.9', volume: '10', price: '100' } };
      if (url.includes('kraken')) return { body: { error: [], result: { SOLUSD: { a: ['101.1'], b: ['100.9'], c: ['101'], v: ['1', '5'] } } } };
      if (url.includes('gemini')) return { status: 400, body: { result: 'error', reason: 'Bad Request' } };
      if (url.includes('okx')) return { body: { code: '51001', data: [] } };
      return { status: 404, body: 'not found' };
    });
    const out = await registry().run(createContext({ http, env: {}, now: () => NOW }), 'crypto.price-compare', { symbol: 'sol-usd' });
    expect(out.source).toBe('Coinbase, Kraken');
    const rows = (out.blocks[1] as TableBlock).rows;
    expect(rows.map((r) => r.venue)).toEqual(['Coinbase', 'Kraken']);
    expect(rows[0]).toMatchObject({ pair: 'SOL-USD', bid: 99.9, ask: 100.1, last: 100 });
    expect(out.notes?.join(' ')).toMatch(/Gemini, Bitstamp, Binance\.US, Bitfinex, OKX/);
  });

  it('fails with the source named when no exchange lists the coin', async () => {
    const { http } = fakeHttp(() => ({ status: 404, body: 'not found' }));
    await expect(registry().run(createContext({ http, env: {}, now: () => NOW }), 'crypto.price-compare', { symbol: 'ZZZ' })).rejects.toThrow(/no exchange quoted ZZZ/);
  });

  it('annualises funding across venues and skips a coin only one venue lists', async () => {
    const { http } = fakeHttp((url) => {
      if (url.includes('hyperliquid'))
        return {
          body: [
            ['BTC', [['BinPerp', { fundingRate: '0.0001', fundingIntervalHours: 8 }], ['HlPerp', { fundingRate: '0.0000125', fundingIntervalHours: 1 }], ['BybitPerp', { fundingRate: '-0.0001', fundingIntervalHours: 8 }]]],
            ['TON', [['HlPerp', { fundingRate: '0', fundingIntervalHours: 1 }]]],
          ],
        };
      if (url.includes('kraken')) return { body: { tickers: [{ symbol: 'PF_XBTUSD', markPrice: 60000, indexPrice: 60000, openInterest: 100, relativeFundingRate: 0.000025 }] } };
      return { status: 503, body: 'down' };
    });
    const out = await registry().run(createContext({ http, env: {}, now: () => NOW }), 'crypto.funding-venues');
    const rows = (out.blocks[0] as TableBlock).rows;
    expect(rows.map((r) => r.coin)).toEqual(['BTC']);
    expect(rows[0].binance).toBeCloseTo(10.95, 9);
    expect(rows[0].bybit).toBeCloseTo(-10.95, 9);
    expect(rows[0].hl).toBeCloseTo(10.95, 9);
    expect(rows[0].kraken).toBeCloseTo(21.9, 9);
    expect(rows[0].dydx).toBeNull();
    expect(rows[0].gap).toBeCloseTo(32.85, 9);
    expect(out.source).toBe('Hyperliquid, Kraken Futures');
    expect(out.notes?.join(' ')).toMatch(/Not answering now: dYdX/);
  });

  it('measures stablecoin issuance and shares', async () => {
    const { http } = fakeHttp(() => ({
      body: {
        peggedAssets: [
          { name: 'Tether', symbol: 'USDT', pegType: 'peggedUSD', pegMechanism: 'fiat-backed', circulating: { peggedUSD: 150e9 }, circulatingPrevDay: { peggedUSD: 150e9 }, circulatingPrevWeek: { peggedUSD: 148e9 }, circulatingPrevMonth: { peggedUSD: 140e9 }, chains: ['Tron'], price: 1 },
          { name: 'USD Coin', symbol: 'USDC', pegType: 'peggedUSD', pegMechanism: 'fiat-backed', circulating: { peggedUSD: 50e9 }, circulatingPrevDay: { peggedUSD: 50e9 }, circulatingPrevWeek: { peggedUSD: 50e9 }, circulatingPrevMonth: { peggedUSD: 60e9 }, chains: ['Ethereum'], price: 1 },
          { name: 'Euro Coin', symbol: 'EURC', pegType: 'peggedEUR', pegMechanism: 'fiat-backed', circulating: { peggedEUR: 1e9 }, chains: ['Ethereum'], price: 1.09 },
        ],
      },
    }));
    const out = await registry().run(createContext({ http, env: {}, now: () => NOW }), 'crypto.stablecoin-supply');
    const stats = Object.fromEntries((out.blocks[0] as StatsBlock).items.map((i) => [i.label, i.value]));
    expect(stats.Outstanding).toBe(200e9);
    expect(stats['Net issuance, 7 days']).toBe(2e9);
    expect(stats['Net issuance, 30 days']).toBe(0);
    expect(stats['USDT share']).toBe(75);
    expect(stats['Stablecoins tracked']).toBe(2);
    expect((out.blocks[1] as TableBlock).rows.map((r) => r.symbol)).toEqual(['USDT', 'USDC']);
  });

  it('reports the source error when a provider is down', async () => {
    const { http } = fakeHttp(() => ({ status: 502, body: 'bad gateway' }));
    const ctx = createContext({ http, env: {}, now: () => NOW });
    await expect(registry().run(ctx, 'crypto.defi-chains')).rejects.toMatchObject({ name: 'SourceError', source: 'DefiLlama', status: 502 });
    await expect(registry().run(ctx, 'crypto.btc-mempool')).rejects.toMatchObject({ name: 'SourceError', source: 'mempool.space' });
    await expect(registry().run(ctx, 'crypto.fear-greed')).rejects.toMatchObject({ name: 'SourceError', source: 'alternative.me' });
  });
});
