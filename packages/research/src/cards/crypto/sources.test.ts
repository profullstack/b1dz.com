/** Parser tests for the crypto sources, on fixtures cut from each provider's real responses. No network. */
import { describe, expect, it } from 'vitest';
import { nextHalving, parseAdjustments, parseBlockchainChart, parseHashrate, parseLightningNodes, parsePools as parseMiningPools, parseProjectedBlocks, subsidyAt, supplyAt } from './bitcoin.js';
import { VENUES, compareQuotes, depthWithin, parseCoinbaseBook, parseKrakenDepth, parsePaprikaHistory, parseVenues } from './coin.js';
import { parseChains, parseDated, parseDimension, parseHacks, parsePools, parseProtocols, parseTotalChart, pickPools } from './defi.js';
import { BTC_ETFS, CRYPTO_STOCKS, ETH_ETFS, MINERS, parseTreasuries } from './equities.js';
import { parseL2Chart, parseL2Projects, parseSupplyParts, parseSupplySeries } from './ethereum.js';
import { parseDerivExchanges, parseReserves, parseSpotExchanges } from './exchanges.js';
import { findCoin, parseGeckoMarkets, parsePaprikaTickers } from './market-data.js';
import { fngLabel, isPegged, movers, parseCategories, parseFearGreed, parseTrending } from './markets.js';
import { matchHeadlines } from './news.js';
import {
  annualise,
  parseBitget,
  parseDydx,
  parseGate,
  parseHlPerps,
  parseHlPredicted,
  parseKrakenFutures,
  parseLiquidations,
  parseLlamaOi,
  parseOkxFundingHistory,
  parseOkxSwaps,
  parseRubik,
} from './perps.js';
import { parseStableChains, parseStableChart, parseStablecoins, pegRows } from './stablecoins.js';
import { baseOf, changeOver, clip, median, share, titleCase, valueAt } from './util.js';

const DAY = 86_400_000;

describe('crypto helpers', () => {
  it('reads a coin from a symbol or a pair', () => {
    expect(baseOf('btc-usd')).toBe('BTC');
    expect(baseOf('ETH/USDT')).toBe('ETH');
    expect(baseOf('solusd')).toBe('SOL');
    expect(baseOf('XBT')).toBe('BTC');
    expect(baseOf(' doge ')).toBe('DOGE');
    expect(baseOf('USDT')).toBe('USDT');
    expect(baseOf('')).toBe('BTC');
    expect(baseOf(undefined, 'ETH')).toBe('ETH');
  });

  it('measures change over days on an ascending series', () => {
    const pts: [number, number][] = [
      [0, 100],
      [10 * DAY, 110],
      [40 * DAY, 121],
    ];
    expect(valueAt(pts, 15 * DAY)).toBe(110);
    expect(valueAt(pts, -1)).toBeNull();
    expect(changeOver(pts, 30)).toBeCloseTo(10, 6);
    expect(changeOver(pts, 400)).toBeNull();
    expect(clip(pts, '1M').map((p) => p[1])).toEqual([110, 121]);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(share(1, 4)).toBe(25);
    expect(share(1, 0)).toBeNull();
    expect(titleCase('hyperliquid l1')).toBe('Hyperliquid L1');
  });
});

describe('CoinPaprika and CoinGecko market lists', () => {
  const paprika = [
    {
      id: 'eth-ethereum',
      name: 'Ethereum',
      symbol: 'ETH',
      rank: 2,
      total_supply: 120232214,
      max_supply: 0,
      quotes: { USD: { price: 1657.49, volume_24h: 6663391816, market_cap: 202630131826, percent_change_1h: -0.24, percent_change_24h: -2.63, percent_change_7d: -8.3, percent_change_30d: -28.1, percent_change_1y: -43.2, ath_price: 4946.23, ath_date: '2025-08-24T19:00:40Z', percent_from_price_ath: -66.39 } },
    },
    {
      id: 'btc-bitcoin',
      name: 'Bitcoin',
      symbol: 'BTC',
      rank: 1,
      total_supply: 20117069,
      max_supply: 21000000,
      quotes: { USD: { price: 59136.45, volume_24h: 19781697338, market_cap: 1189651905525, percent_change_1h: -0.43, percent_change_24h: -2.17, percent_change_7d: -8.1, percent_change_30d: -25.55, percent_change_1y: -31.92, ath_price: 126173.17, ath_date: '2025-10-06T19:00:40Z', percent_from_price_ath: -53.09 } },
    },
    { id: 'dead-coin', name: 'Dead', symbol: 'DEAD', rank: 0, quotes: { USD: { price: 0 } } },
    { id: 'eth-fake', name: 'Fake Ether', symbol: 'ETH', rank: 400, quotes: { USD: { price: 0.01, market_cap: 1000 } } },
  ];

  it('parses CoinPaprika tickers in rank order and drops dead rows', () => {
    const coins = parsePaprikaTickers(paprika);
    expect(coins.map((c) => c.id)).toEqual(['btc-bitcoin', 'eth-ethereum', 'eth-fake']);
    expect(coins[0]).toMatchObject({ symbol: 'BTC', price: 59136.45, marketCap: 1189651905525, chg24h: -2.17, chg1y: -31.92, athDate: '2025-10-06', fromAth: -53.09, maxSupply: 21000000 });
    expect(coins[1].maxSupply).toBeNull();
    expect(parsePaprikaTickers({ error: 'nope' })).toEqual([]);
  });

  it('parses CoinGecko markets into the same shape', () => {
    const coins = parseGeckoMarkets([
      { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 59125, market_cap: 1189387367352, market_cap_rank: 1, total_volume: 28262087652, price_change_percentage_24h: -1.92379, circulating_supply: 20116959, max_supply: 21000000, ath: 126080, ath_change_percentage: -53.10484, ath_date: '2025-10-06T10:57:42.000Z', price_change_percentage_1h_in_currency: 0.3007, price_change_percentage_7d_in_currency: -7.6835, price_change_percentage_30d_in_currency: -25.361 },
      { id: 'unranked', symbol: 'x', name: 'X', current_price: 1, market_cap_rank: null },
    ]);
    expect(coins).toHaveLength(1);
    expect(coins[0]).toMatchObject({ id: 'bitcoin', symbol: 'BTC', rank: 1, chg1h: 0.3007, chg24h: -1.92379, chg7d: -7.6835, chg30d: -25.361, chg1y: null, athDate: '2025-10-06', supply: 20116959 });
  });

  it('resolves a symbol to the best-ranked coin, then a name', () => {
    const coins = parsePaprikaTickers(paprika);
    expect(findCoin(coins, 'eth')?.id).toBe('eth-ethereum');
    expect(findCoin(coins, 'Bitcoin')?.id).toBe('btc-bitcoin');
    expect(findCoin(coins, 'zzz')).toBeUndefined();
  });

  it('ranks movers among liquid, unpegged coins only', () => {
    const coin = (symbol: string, rank: number, chg24h: number, volume24h = 5e6, extra: Partial<ReturnType<typeof parsePaprikaTickers>[number]> = {}) => ({
      ...parsePaprikaTickers(paprika)[0],
      id: symbol,
      symbol,
      rank,
      chg24h,
      chg7d: chg24h * 2,
      chg30d: chg24h * 3,
      volume24h,
      ...extra,
    });
    const coins = [coin('UP', 5, 12), coin('DOWN', 6, -9), coin('FLAT', 7, 0.1), coin('THIN', 8, 50, 1000), coin('FAR', 900, 80), coin('USDT', 3, 2), coin('MID', 9, 3)];
    expect(isPegged(coins[2])).toBe(true);
    expect(isPegged(coins[0])).toBe(false);
    const { up, down } = movers(coins, 'chg24h', 200, 1_000_000);
    expect(up.map((c) => c.symbol)).toEqual(['UP', 'MID']);
    expect(down.map((c) => c.symbol)).toEqual(['DOWN']);
  });
});

describe('sentiment and sectors', () => {
  it('parses the Fear and Greed Index oldest first', () => {
    const pts = parseFearGreed({ name: 'Fear and Greed Index', data: [{ value: '13', value_classification: 'Extreme Fear', timestamp: '1795564800', time_until_update: '71408' }, { value: '11', value_classification: 'Extreme Fear', timestamp: '1795478400' }, { value: 'x' }] });
    expect(pts).toEqual([
      { t: 1795478400000, value: 11, label: 'Extreme Fear' },
      { t: 1795564800000, value: 13, label: 'Extreme Fear' },
    ]);
    expect([5, 30, 50, 60, 90].map(fngLabel)).toEqual(['Extreme Fear', 'Fear', 'Neutral', 'Greed', 'Extreme Greed']);
  });

  it('parses CoinGecko trending coins, including dollar strings', () => {
    const coins = parseTrending({
      coins: [{ item: { id: 'solana', name: 'Solana', symbol: 'SOL', market_cap_rank: 7, data: { price: 69.18, price_change_percentage_24h: { usd: -3.41, eur: -3.2 }, market_cap: '$40,963,792,970', total_volume: '$2,402,821,234' } } }, { item: {} }],
    });
    expect(coins).toEqual([{ name: 'Solana', symbol: 'SOL', rank: 7, price: 69.18, chg24h: -3.41, marketCap: 40963792970, volume: 2402821234 }]);
  });

  it('parses CoinGecko categories largest first', () => {
    const cats = parseCategories([
      { id: 'layer-1', name: 'Layer 1 (L1)', market_cap: 1685284476712, market_cap_change_24h: -1.97, volume_24h: 47206789016 },
      { id: 'smart-contract-platform', name: 'Smart Contract Platform', market_cap: 1708344420455, market_cap_change_24h: -2.0, volume_24h: 48587697530 },
      { id: 'empty', name: 'Empty', market_cap: null },
    ]);
    expect(cats.map((c) => c.name)).toEqual(['Smart Contract Platform', 'Layer 1 (L1)']);
    expect(cats[0].chg24h).toBe(-2);
  });
});

describe('one coin', () => {
  it('parses CoinPaprika markets, dropping outliers and dead markets', () => {
    const venues = parseVenues([
      { exchange_name: 'Coinbase', pair: 'BTC/USD', category: 'Spot', outlier: false, adjusted_volume_24h_share: 3.94, quotes: { USD: { price: 59149.49, volume_24h: 779739172.2 } }, trust_score: 'high' },
      { exchange_name: 'Binance', pair: 'BTC/USDT', category: 'Spot', outlier: false, adjusted_volume_24h_share: 5.63, quotes: { USD: { price: 59130.14, volume_24h: 1114278251.4 } }, trust_score: 'high' },
      { exchange_name: 'Wash', pair: 'BTC/USDT', category: 'Spot', outlier: true, quotes: { USD: { price: 70000, volume_24h: 9e12 } } },
      { exchange_name: 'Idle', pair: 'BTC/EUR', category: 'Spot', outlier: false, quotes: { USD: { price: 59000, volume_24h: 0 } } },
    ]);
    expect(venues.map((v) => v.exchange)).toEqual(['Binance', 'Coinbase']);
    expect(venues[0]).toMatchObject({ pair: 'BTC/USDT', price: 59130.14, trust: 'high' });
  });

  it('reads each exchange ticker', () => {
    const by = Object.fromEntries(VENUES.map((v) => [v.name, v]));
    expect(by.Coinbase.url('SOL')).toBe('https://api.exchange.coinbase.com/products/SOL-USD/ticker');
    expect(by.Coinbase.parse({ ask: '59128.02', bid: '59128.01', volume: '12860.92', price: '59128.02' }, 'BTC')).toEqual({ bid: 59128.01, ask: 59128.02, last: 59128.02, volume: 12860.92 });
    expect(by.Kraken.url('BTC')).toContain('pair=XBTUSD');
    expect(by.Kraken.parse({ error: [], result: { SOLUSD: { a: ['69.20000', '303', '303.000'], b: ['69.19000', '42', '42.000'], c: ['69.20000', '1.44508671'], v: ['76835.77', '397947.31'] } } }, 'SOL')).toEqual({ bid: 69.19, ask: 69.2, last: 69.2, volume: 397947.31 });
    expect(by.Gemini.parse({ bid: '69.17200', ask: '69.20900', last: '69.19800', volume: { SOL: '11779.35', USD: '815107.46', timestamp: 1795580040000 } }, 'SOL')).toEqual({ bid: 69.172, ask: 69.209, last: 69.198, volume: 11779.35 });
    expect(by.Bitstamp.parse({ last: '69.176', volume: '149179.85', bid: '69.188', ask: '69.189' }, 'SOL')).toEqual({ bid: 69.188, ask: 69.189, last: 69.176, volume: 149179.85 });
    expect(by['Binance.US'].parse({ symbol: 'SOLUSD', lastPrice: '69.22', bidPrice: '69.2', askPrice: '69.3', volume: '8500' }, 'SOL')).toEqual({ bid: 69.2, ask: 69.3, last: 69.22, volume: 8500 });
    expect(by.Bitfinex.url('BTC')).toMatch(/tBTCUSD$/);
    expect(by.Bitfinex.url('AVAX')).toMatch(/tAVAX:USD$/);
    expect(by.Bitfinex.parse([69.272, 921.09, 69.318, 1019.13, -2.724, -0.0378, 69.2, 22375.66, 72.038, 68.561], 'SOL')).toEqual({ bid: 69.272, ask: 69.318, last: 69.2, volume: 22375.66 });
    expect(by.OKX.parse({ code: '0', data: [{ instId: 'SOL-USDT', last: '69.28', askPx: '69.29', bidPx: '69.28', vol24h: '812000' }] }, 'SOL')).toEqual({ bid: 69.28, ask: 69.29, last: 69.28, volume: 812000 });
    // An unlisted pair answers with an error body, not a ticker.
    expect(by.Coinbase.parse({ message: 'NotFound' }, 'ZZZ')).toBeNull();
    expect(by.Kraken.parse({ error: ['EQuery:Unknown asset pair'] }, 'ZZZ')).toBeNull();
    expect(by.OKX.parse({ code: '51001', data: [] }, 'ZZZ')).toBeNull();
    expect(by.Bitfinex.parse(['error', 10020, 'symbol: invalid'], 'ZZZ')).toBeNull();
  });

  it('compares venues against the median mid', () => {
    const { rows, mid, rangeBp } = compareQuotes([
      { venue: 'A', pair: 'X-USD', bid: 99.9, ask: 100.1, last: 100, volume: 10 },
      { venue: 'B', pair: 'X-USD', bid: 100.9, ask: 101.1, last: 101, volume: 5 },
      { venue: 'C', pair: 'X-USD', bid: null, ask: null, last: 100.5, volume: null },
    ]);
    expect(mid).toBeCloseTo(100.5, 9);
    expect(rangeBp).toBeCloseTo((1 / 100.5) * 10_000, 6);
    expect(rows[0].spreadBp).toBeCloseTo(20, 6);
    expect(rows[0].vsMid).toBeCloseTo((100 / 100.5 - 1) * 10_000, 6);
    expect(rows[0].volume).toBeCloseTo(1000, 6);
    expect(rows[2]).toMatchObject({ spreadBp: null, volume: null });
    expect(rows[2].vsMid).toBeCloseTo(0, 9);
  });

  it('parses order books best first and sums depth near the mid', () => {
    const kraken = parseKrakenDepth({ error: [], result: { XXBTZUSD: { asks: [['59137.10000', '0.254', 1795579848], ['59137.00000', '0.120', 1795579848]], bids: [['59136.00000', '0.500', 1795579848], ['59136.90000', '1.000', 1795579848]] } } });
    expect(kraken.asks[0]).toEqual([59137, 0.12]);
    expect(kraken.bids[0]).toEqual([59136.9, 1]);
    const cb = parseCoinbaseBook({ bids: [['59128.01', '0.00162398', 3], ['59127.88', '0.07399171', 1]], asks: [['59128.02', '0.5', 1]] });
    expect(cb.bids).toHaveLength(2);
    expect(cb.asks[0]).toEqual([59128.02, 0.5]);
    expect(parseKrakenDepth({ error: ['EQuery:Unknown asset pair'] })).toEqual({ bids: [], asks: [] });
    const side: [number, number][] = [
      [99.8, 1],
      [99.5, 2],
      [90, 100],
    ];
    expect(depthWithin(side, 100, 0.25)).toBeCloseTo(99.8, 9);
    expect(depthWithin(side, 100, 1)).toBeCloseTo(99.8 + 199, 9);
  });

  it('parses CoinPaprika history oldest first', () => {
    const pts = parsePaprikaHistory([
      { timestamp: '2026-01-02T00:00:00Z', price: 89351.04, volume_24h: 26162568637, market_cap: 1784385917223 },
      { timestamp: '2026-01-01T00:00:00Z', price: 87905.36, volume_24h: 24721992392, market_cap: 1755474223484 },
      { timestamp: 'bad', price: 1 },
    ]);
    expect(pts.map((p) => p.price)).toEqual([87905.36, 89351.04]);
    expect(pts[0]).toMatchObject({ t: Date.UTC(2026, 0, 1), marketCap: 1755474223484, volume: 24721992392 });
    expect(parsePaprikaHistory({ error: 'not allowed in this plan' })).toEqual([]);
  });
});

describe('derivatives venues', () => {
  it('annualises a funding rate by its interval', () => {
    expect(annualise(0.0001, 8)).toBeCloseTo(10.95, 9);
    expect(annualise(0.0000125, 1)).toBeCloseTo(10.95, 9);
    expect(annualise(null, 8)).toBeNull();
    expect(annualise(0.0001, 0)).toBeNull();
  });

  it('parses Hyperliquid markets by position in the universe', () => {
    const perps = parseHlPerps([
      { universe: [{ name: 'BTC', szDecimals: 5 }, { name: 'OLD', isDelisted: true }, { name: 'ETH' }] },
      [
        { funding: '-0.0000074055', openInterest: '35264.10944', prevDayPx: '60384.0', dayNtlVlm: '2953118865.01', premium: '-0.0005066369', markPx: '59181.0' },
        { funding: '0', openInterest: '0', markPx: '1.0' },
        { funding: '0.0000125', openInterest: '620000', prevDayPx: '1700', dayNtlVlm: '789650000', premium: '-0.00029', markPx: '1659.5' },
      ],
    ]);
    expect(perps.map((p) => p.coin)).toEqual(['BTC', 'ETH']);
    expect(perps[0]).toEqual({ coin: 'BTC', mark: 59181, prevDay: 60384, funding: -0.0000074055, openInterest: 35264.10944, volume: 2953118865.01, premium: -0.0005066369 });
    expect(parseHlPerps({})).toEqual([]);
  });

  it('parses the Hyperliquid funding comparison feed', () => {
    const map = parseHlPredicted([
      ['BTC', [['BinPerp', { fundingRate: '0.00007681', nextFundingTime: 1795593600000, fundingIntervalHours: 8 }], ['HlPerp', { fundingRate: '-0.0000071344', nextFundingTime: 1795579200000, fundingIntervalHours: 1 }], ['BybitPerp', { fundingRate: '-0.00000787', fundingIntervalHours: 8 }], ['Odd', null]]],
      ['EMPTY', []],
    ]);
    expect([...map.keys()]).toEqual(['BTC']);
    expect(map.get('BTC')).toEqual([
      { venue: 'Binance', rate: 0.00007681, hours: 8 },
      { venue: 'Hyperliquid', rate: -0.0000071344, hours: 1 },
      { venue: 'Bybit', rate: -0.00000787, hours: 8 },
    ]);
  });

  it('parses Kraken Futures symbols, sizing inverse contracts in dollars', () => {
    const rows = parseKrakenFutures({
      result: 'success',
      tickers: [
        { symbol: 'PF_XBTUSD', tag: 'perpetual', markPrice: 59134.35, indexPrice: 59134.05, vol24h: 8818.86, volumeQuote: 527950594.61, openInterest: 2154.3944, fundingRate: 0.606, relativeFundingRate: 0.000010213416666667, change24h: -2.07 },
        { symbol: 'FF_SOLUSD_261225', tag: 'quarter', markPrice: 69.07, indexPrice: 69, vol24h: 101.57, volumeQuote: 7079.62, openInterest: 5244.65, change24h: -1.93 },
        { symbol: 'PI_XBTUSD', markPrice: 59100, indexPrice: 59134, vol24h: 1200000, openInterest: 5000000 },
        { symbol: 'PF_HALTUSD', markPrice: 1, suspended: true },
        { symbol: 'rr_xbtusd', markPrice: 59000 },
      ],
    });
    expect(rows.map((r) => r.symbol)).toEqual(['PF_XBTUSD', 'FF_SOLUSD_261225', 'PI_XBTUSD']);
    expect(rows[0]).toMatchObject({ base: 'BTC', kind: 'perpetual', inverse: false, expiry: null, funding: 0.000010213416666667, volume: 527950594.61 });
    expect(rows[0].openInterest).toBeCloseTo(2154.3944 * 59134.35, 3);
    expect(rows[1]).toMatchObject({ base: 'SOL', kind: 'dated', expiry: '2026-12-25', funding: null });
    expect(rows[2]).toMatchObject({ base: 'BTC', inverse: true, openInterest: 5000000, volume: 1200000 });
  });

  it('parses dYdX markets with open interest in dollars', () => {
    const rows = parseDydx({ markets: { 'BTC-USD': { ticker: 'BTC-USD', status: 'ACTIVE', oraclePrice: '59153.54', volume24H: '15544363.05', nextFundingRate: '0.00003935', openInterest: '313.2138' }, 'OLD-USD': { ticker: 'OLD-USD', status: 'FINAL_SETTLEMENT', oraclePrice: '1' } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ coin: 'BTC', price: 59153.54, funding: 0.00003935, volume: 15544363.05 });
    expect(rows[0].openInterest).toBeCloseTo(313.2138 * 59153.54, 3);
  });

  it('joins OKX swap tickers to open interest', () => {
    const rows = parseOkxSwaps(
      [
        { instType: 'SWAP', instId: 'BTC-USDT-SWAP', last: '59182.4', open24h: '60470', volCcy24h: '123400' },
        { instType: 'SWAP', instId: 'BTC-USD-SWAP', last: '59098.8', open24h: '60390', volCcy24h: '6440' },
        { instType: 'SWAP', instId: 'WEIRD', last: '1' },
      ],
      [{ instId: 'BTC-USD-SWAP', oi: '6619311.9', oiCcy: '11191.66', oiUsd: '661931189.99' }, { instId: 'BTC-USDT-SWAP', oiUsd: '1820000000' }],
    );
    expect(rows).toEqual([
      { instId: 'BTC-USDT-SWAP', base: 'BTC', quote: 'USDT', last: 59182.4, open24h: 60470, volumeCoin: 123400, oiUsd: 1820000000 },
      { instId: 'BTC-USD-SWAP', base: 'BTC', quote: 'USD', last: 59098.8, open24h: 60390, volumeCoin: 6440, oiUsd: 661931189.99 },
    ]);
  });

  it('reads Bitget and Gate open interest in dollars', () => {
    const bitget = { code: '00000', data: [{ symbol: 'ETHUSDT', markPrice: '1659.12', holdingAmount: '100' }, { symbol: 'BTCUSDT', lastPr: '59182.3', markPrice: '59182.3', usdtVolume: '2761142849.55', holdingAmount: '35847.3734', fundingRate: '-0.000006' }] };
    expect(parseBitget(bitget, 'BTC')?.oi).toBeCloseTo(35847.3734 * 59182.3, 2);
    expect(parseBitget(bitget, 'BTC')?.volume).toBe(2761142849.55);
    expect(parseBitget(bitget, 'DOGE')).toBeNull();
    const gate = parseGate({ name: 'BTC_USDT', mark_price: '59188.96', position_size: 296969336, quanto_multiplier: '0.0001', funding_rate: '0.0000205', funding_interval: 28800 });
    expect(gate?.oi).toBeCloseTo(296969336 * 0.0001 * 59188.96, 2);
    expect(gate?.funding).toBeCloseTo(0.0000205 * 3 * 365 * 100, 9);
    expect(parseGate({ label: 'CONTRACT_NOT_FOUND' })).toBeNull();
  });

  it('parses OKX statistics rows, liquidations and funding history', () => {
    expect(parseRubik([['1795536000000', '2.62'], ['1795449600000', '2.57'], ['bad', 'x'], []])).toEqual([
      [1795449600000, 2.57],
      [1795536000000, 2.62],
    ]);
    const fills = parseLiquidations([
      {
        instId: 'BTC-USDT-SWAP',
        details: [
          { bkLoss: '0', bkPx: '59058.8', posSide: 'long', side: 'sell', sz: '8.05', ts: '1795579517346' },
          { bkPx: '59500', posSide: '', side: 'buy', sz: '2', ts: '1795579600000' },
          { bkPx: 'x', sz: '1', ts: '1' },
        ],
      },
    ]);
    expect(fills).toEqual([
      { t: 1795579600000, side: 'short', price: 59500, size: 2 },
      { t: 1795579517346, side: 'long', price: 59058.8, size: 8.05 },
    ]);
    expect(parseOkxFundingHistory([{ fundingRate: '0.0000555', fundingTime: '1795564800000', realizedRate: '0.0000551' }, { fundingRate: '0.00004', fundingTime: '1795536000000' }])).toEqual([
      { t: 1795536000000, rate: 0.00004 },
      { t: 1795564800000, rate: 0.0000551 },
    ]);
  });

  it('parses DefiLlama open interest largest first', () => {
    const rows = parseLlamaOi({
      total24h: 13730859268,
      protocols: [
        { name: 'Synthetix v1+v2', total24h: 0, category: 'Synthetics', chains: ['OP Mainnet'] },
        { name: 'Aster Perps', displayName: 'Aster Perps', total24h: 1056552278, total7DaysAgo: 1180000000, total30DaysAgo: 1418000000, category: 'Derivatives', chains: ['Off Chain'] },
        { name: 'Hyperliquid Perps', total24h: 4846839835, total7DaysAgo: 5540000000, category: 'Derivatives', chains: ['Hyperliquid L1'] },
        { name: 'dYdX V3', total24h: null },
      ],
    });
    expect(rows.map((r) => r.name)).toEqual(['Hyperliquid Perps', 'Aster Perps']);
    expect(rows[0]).toMatchObject({ oi: 4846839835, weekAgo: 5540000000, monthAgo: null, chains: ['Hyperliquid L1'] });
  });
});

describe('DefiLlama', () => {
  it('parses dated series and chain lists', () => {
    expect(parseDated([{ date: 1506556800, tvl: 5 }, { date: 1506470400, tvl: 0 }, { date: 'x' }], 'tvl')).toEqual([
      [1506470400000, 0],
      [1506556800000, 5],
    ]);
    const chains = parseChains([{ name: 'Moonbeam', tvl: 0, tokenSymbol: 'GLMR' }, { name: 'Mantle', tvl: 78063230, tokenSymbol: 'MNT' }, { name: 'Ethereum', tvl: 35940000000, tokenSymbol: 'ETH' }]);
    expect(chains).toEqual([
      { name: 'Ethereum', token: 'ETH', tvl: 35940000000 },
      { name: 'Mantle', token: 'MNT', tvl: 78063230 },
    ]);
  });

  it('parses protocols with their Ethereum value', () => {
    const rows = parseProtocols([
      { name: 'Lido', category: 'Liquid Staking', chains: ['Ethereum', 'Solana'], tvl: 16180000000, change_1d: -2.63, change_7d: -8.18, mcap: 187430000, chainTvls: { Ethereum: 16170000000, Solana: 10000000 } },
      { name: 'Binance CEX', category: 'CEX', chains: ['Ethereum'], tvl: 107395364922, chainTvls: { Ethereum: 49688464353 } },
      { name: 'Dust', category: 'Yield', tvl: 0 },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Binance CEX', 'Lido']);
    expect(rows[1]).toEqual({ name: 'Lido', category: 'Liquid Staking', chains: ['Ethereum', 'Solana'], tvl: 16180000000, chg1d: -2.63, chg7d: -8.18, mcap: 187430000, ethereumTvl: 16170000000 });
  });

  it('parses a volume or fees overview with its chain breakdown and chart', () => {
    const body = {
      total24h: 8127888834,
      totalDataChart: [[1392681600, 0], [1392595200, 6.23], ['x', 1]],
      protocols: [
        { name: 'Curve DEX', displayName: 'Curve DEX', category: 'Dexs', chains: ['Ethereum', 'Arbitrum'], total24h: 99424556, total7d: 863509135, total30d: 4814023173, total1y: 58977145101, change_7dover7d: -1.87, breakdown24h: { ethereum: { 'Curve DEX': 96348238 }, arbitrum: { 'Curve DEX': 1249204, 'Curve LlamaLend': 1000 } } },
        { name: 'Uniswap V3', category: 'Dexs', chains: ['Ethereum'], total24h: 900000000, breakdown24h: null },
        { name: 'Quiet', total24h: 0 },
      ],
    };
    const rows = parseDimension(body);
    expect(rows.map((r) => r.name)).toEqual(['Uniswap V3', 'Curve DEX']);
    expect(rows[1]).toMatchObject({ d1: 99424556, d7: 863509135, d30: 4814023173, y1: 58977145101, wow: -1.87, breakdown24h: { ethereum: 96348238, arbitrum: 1250204 } });
    expect(rows[0].breakdown24h).toEqual({});
    expect(parseTotalChart(body)).toEqual([
      [1392595200000, 6.23],
      [1392681600000, 0],
    ]);
  });

  it('parses and filters yield pools', () => {
    const pools = parsePools({
      status: 'success',
      data: [
        { chain: 'Ethereum', project: 'lido', symbol: 'STETH', tvlUsd: 16055902839, apyBase: 2.39, apyReward: null, apy: 2.39, stablecoin: false, ilRisk: 'no', exposure: 'single', outlier: false, apyMean30d: 2.71 },
        { chain: 'Ethereum', project: 'sky-lending', symbol: 'SUSDS', tvlUsd: 1940000000, apy: 3.8, apyBase: 3.8, stablecoin: true, ilRisk: 'no', exposure: 'single', outlier: false },
        { chain: 'Base', project: 'aero', symbol: 'USDC-WETH', tvlUsd: 80000000, apy: 40, stablecoin: false, ilRisk: 'yes', exposure: 'multi', outlier: false },
        { chain: 'Base', project: 'scam', symbol: 'USDX', tvlUsd: 90000000, apy: 900, stablecoin: true, outlier: true },
        { chain: 'Base', project: 'tiny', symbol: 'USDC', tvlUsd: 100, apy: 5, stablecoin: true, outlier: false },
        { chain: 'Base', project: 'broken', symbol: 'X' },
      ],
    });
    expect(pools).toHaveLength(5);
    expect(pickPools(pools, { filter: 'stablecoins', minTvl: 50e6 }).map((p) => p.project)).toEqual(['sky-lending']);
    expect(pickPools(pools, { filter: 'all', minTvl: 50e6 }).map((p) => p.project)).toEqual(['aero', 'sky-lending', 'lido']);
    expect(pickPools(pools, { filter: 'single asset', minTvl: 50e6 }).map((p) => p.project)).toEqual(['sky-lending', 'lido']);
    expect(pickPools(pools, { filter: 'largest', minTvl: 50e6 }).map((p) => p.project)).toEqual(['lido', 'sky-lending', 'aero']);
    expect(pickPools(pools, { filter: 'all', chain: 'base', minTvl: 50e6 }).map((p) => p.project)).toEqual(['aero']);
  });

  it('parses hacks newest first', () => {
    const hacks = parseHacks([
      { date: 1641081600, name: 'DefiChain', classification: 'Token & Share Accounting', technique: 'Incorrect Fee Accounting', amount: null, chain: ['DefiChain'] },
      { date: 1647475200, name: 'ApeCoin', classification: 'Governance', technique: 'Flashloan Governance Attack', amount: 820000, chain: ['Ethereum', 'BSC'] },
      { name: 'No date' },
    ]);
    expect(hacks.map((h) => h.name)).toEqual(['ApeCoin', 'DefiChain']);
    expect(hacks[0]).toMatchObject({ t: 1647475200000, amount: 820000, chain: 'Ethereum, BSC' });
    expect(hacks[1].amount).toBeNull();
  });
});

describe('stablecoins', () => {
  const body = {
    peggedAssets: [
      { id: '2', name: 'USD Coin', symbol: 'USDC', pegType: 'peggedUSD', pegMechanism: 'fiat-backed', circulating: { peggedUSD: 69020000000 }, circulatingPrevDay: { peggedUSD: 69366000000 }, circulatingPrevWeek: { peggedUSD: 69325000000 }, circulatingPrevMonth: { peggedUSD: 71717000000 }, chains: ['Ethereum', 'Solana', 'Base'], price: 0.9999 },
      { id: '1', name: 'Tether', symbol: 'USDT', pegType: 'peggedUSD', pegMechanism: 'fiat-backed', circulating: { peggedUSD: 174171307560 }, circulatingPrevDay: { peggedUSD: 174609135502 }, circulatingPrevWeek: { peggedUSD: 175156837383 }, circulatingPrevMonth: { peggedUSD: 182209021366 }, chains: ['Tron', 'Ethereum'], price: 0.99857 },
      { id: '9', name: 'apxUSD', symbol: 'apxUSD', pegType: 'peggedUSD', pegMechanism: 'crypto-backed', circulating: { peggedUSD: 249210000 }, chains: ['Ethereum'], price: 0.9638 },
      { id: '7', name: 'Euro Coin', symbol: 'EURC', pegType: 'peggedEUR', pegMechanism: 'fiat-backed', circulating: { peggedEUR: 240000000 }, chains: ['Ethereum'], price: 1.09 },
      { id: '8', name: 'Gone', symbol: 'GONE', pegType: 'peggedUSD', circulating: { peggedUSD: 0 } },
    ],
  };

  it('parses supply by peg type, largest first', () => {
    const coins = parseStablecoins(body);
    expect(coins.map((c) => c.symbol)).toEqual(['USDT', 'USDC', 'EURC', 'apxUSD']);
    expect(coins[0]).toMatchObject({ pegType: 'peggedUSD', mechanism: 'fiat-backed', supply: 174171307560, prevDay: 174609135502, prevMonth: 182209021366, price: 0.99857, chains: 2 });
    expect(coins[2]).toMatchObject({ pegType: 'peggedEUR', supply: 240000000 });
    expect(coins[3].prevDay).toBeNull();
  });

  it('ranks dollar pegs by distance from one dollar', () => {
    const rows = pegRows(parseStablecoins(body), 100e6);
    expect(rows.map((r) => r.symbol)).toEqual(['apxUSD', 'USDT', 'USDC']);
    expect(rows[0].bp).toBeCloseTo(-362, 6);
    expect(rows[1].bp).toBeCloseTo(-14.3, 6);
    expect(pegRows(parseStablecoins(body), 1e9).map((r) => r.symbol)).toEqual(['USDT', 'USDC']);
  });

  it('parses supply by chain and through time', () => {
    expect(parseStableChains([{ totalCirculatingUSD: { peggedUSD: 5680982.9 }, name: 'Manta' }, { totalCirculatingUSD: { peggedUSD: 0 }, name: 'ThunderCore' }, { totalCirculatingUSD: { peggedUSD: 127900000000, peggedEUR: 5 }, name: 'Ethereum' }])).toEqual([
      { name: 'Ethereum', usd: 127900000000 },
      { name: 'Manta', usd: 5680982.9 },
    ]);
    expect(parseStableChart([{ date: '1512000000', totalCirculating: { peggedUSD: 109970 }, totalCirculatingUSD: { peggedUSD: 110105 } }, { date: '1511913600', totalCirculatingUSD: { peggedUSD: 110100 } }, { date: '1', totalCirculatingUSD: {} }])).toEqual([
      [1511913600000, 110100],
      [1512000000000, 110105],
    ]);
  });
});

describe('Bitcoin', () => {
  it('follows the reward schedule', () => {
    expect(subsidyAt(0)).toBe(50);
    expect(subsidyAt(209_999)).toBe(50);
    expect(subsidyAt(210_000)).toBe(25);
    expect(subsidyAt(977_462)).toBe(3.125);
    expect(subsidyAt(33 * 210_000)).toBe(0);
    expect(supplyAt(0)).toBe(50);
    expect(supplyAt(209_999)).toBe(10_500_000);
    expect(supplyAt(210_000)).toBe(10_500_025);
    // Four full eras (19,687,500 BTC) plus 137,463 blocks at 3.125.
    expect(supplyAt(977_462)).toBeCloseTo(19_687_500 + 137_463 * 3.125, 6);
    expect(supplyAt(40 * 210_000)).toBeLessThan(21_000_000);
    expect(nextHalving(977_462)).toEqual({ height: 1_050_000, blocksLeft: 72_538, subsidyAfter: 1.5625 });
    expect(nextHalving(840_000).blocksLeft).toBe(210_000);
  });

  it('parses projected blocks and their fee range', () => {
    const blocks = parseProjectedBlocks([{ blockSize: 1579434, blockVSize: 997995, nTx: 3910, totalFees: 1681982, medianFee: 1.0048, feeRange: [0.12, 0.13, 1.4, 3.01, 200.54] }, { blockVSize: 997944.25, nTx: 7982, totalFees: 120983, medianFee: 0.1212, feeRange: [] }, { nTx: 1 }]);
    expect(blocks).toEqual([
      { txs: 3910, vsize: 997995, totalFees: 1681982, medianFee: 1.0048, minFee: 0.12, maxFee: 200.54 },
      { txs: 7982, vsize: 997944.25, totalFees: 120983, medianFee: 0.1212, minFee: null, maxFee: null },
    ]);
  });

  it('parses hashrate in exahashes and difficulty history', () => {
    const h = parseHashrate({ hashrates: [{ timestamp: 1764201600, avgHashrate: 1.244650449569087e21 }, { timestamp: 1764115200, avgHashrate: 876812572936139000000 }], difficulty: [{ time: 1764206208, height: 925344, difficulty: 149301205959699.9, adjustment: 0.98 }], currentHashrate: 1.037121371464954e21, currentDifficulty: 134823837323272.7 });
    expect(h.hashrate[0][0]).toBe(1764115200000);
    expect(h.hashrate[0][1]).toBeCloseTo(876.8125729, 6);
    expect(h.hashrate[1][1]).toBeCloseTo(1244.6504496, 6);
    expect(h.current).toBeCloseTo(1037.1213715, 6);
    expect(h.difficulty).toEqual([[1764206208000, 149301205959699.9]]);
    expect(parseHashrate({})).toEqual({ hashrate: [], difficulty: [], current: null, currentDifficulty: null });
  });

  it('parses difficulty adjustments newest first', () => {
    const rows = parseAdjustments([[1793301298, 973728, 148364561003867.4, 1.05539], [1794632570, 975744, 134823837323272.7, 0.908733], ['x']]);
    expect(rows.map((r) => r.height)).toEqual([975744, 973728]);
    expect(rows[0].change).toBeCloseTo(-9.1267, 4);
    expect(rows[1].change).toBeCloseTo(5.539, 4);
  });

  it('parses mining pools with the network hashrate', () => {
    const p = parseMiningPools({ pools: [{ poolId: 45, name: 'AntPool', blockCount: 246, emptyBlocks: 1 }, { poolId: 112, name: 'Foundry USA', blockCount: 247, emptyBlocks: 0 }, { name: 'None', blockCount: 0 }], blockCount: 1088, lastEstimatedHashrate: 960241796237705600000 });
    expect(p.pools).toEqual([
      { name: 'Foundry USA', blocks: 247, empty: 0 },
      { name: 'AntPool', blocks: 246, empty: 1 },
    ]);
    expect(p.total).toBe(1088);
    expect(p.hashrate).toBeCloseTo(960.2418, 4);
  });

  it('parses 1ML nodes, keeping printable aliases', () => {
    const nodes = parseLightningNodes([
      { pub_key: '027100442c3b79f606f80f322d98d499eefcb060599efc5d4ecb00209c2cb54190', alias: 'block-iad-1', capacity: 21656999489, channelcount: 438 },
      { pub_key: '02aaaa1111bbbb2222cccc3333', alias: 'Kraken \u{1F419}⚡', capacity: 14760153834, channelcount: 477 },
      { pub_key: 'e960fd8385a1603003727abcdef', alias: '', capacity: 11830000000, channelcount: 217 },
      { alias: 'broken' },
    ]);
    expect(nodes).toEqual([
      { alias: 'block-iad-1', capacity: 216.56999489, channels: 438 },
      { alias: 'Kraken', capacity: 147.60153834, channels: 477 },
      { alias: 'e960fd8385a16030...', capacity: 118.3, channels: 217 },
    ]);
  });

  it('parses a Blockchain.com chart', () => {
    expect(parseBlockchainChart({ status: 'ok', name: 'Confirmed Transactions Per Day', values: [{ x: 1764115200, y: 477042 }, { x: 1764028800, y: 350825 }, { x: 'bad' }] })).toEqual([
      [1764028800000, 350825],
      [1764115200000, 477042],
    ]);
    expect(parseBlockchainChart({ status: 'not-found' })).toEqual([]);
  });
});

describe('Ethereum', () => {
  it('derives supply and stake from the ultrasound.money parts', () => {
    const parts = parseSupplyParts({ beaconBalancesSum: '44713401159172632', beaconDepositsSum: '93162937953219286', executionBalancesSum: '170698468500119753395218951', slot: 15729648 });
    expect(parts?.staked).toBeCloseTo(44_713_401.159, 2);
    expect(parts?.deposited).toBeCloseTo(93_162_937.953, 2);
    // 170,698,468.5 on the execution layer + 44,713,401.2 staked - 93,162,938.0 deposited.
    expect(parts?.supply).toBeCloseTo(122_248_931.706, 1);
    expect(parseSupplyParts({ beaconBalancesSum: '1' })).toBeNull();
  });

  it('parses a supply window oldest first', () => {
    const body = { since_merge: [{ supply: 120521200, timestamp: '2022-09-16T00:00:00Z' }, { supply: 120521140.92, timestamp: '2022-09-15T00:00:00Z' }, { supply: 'x', timestamp: 'bad' }], d1: [] };
    expect(parseSupplySeries(body, 'since_merge')).toEqual([
      [Date.UTC(2022, 8, 15), 120521140.92],
      [Date.UTC(2022, 8, 16), 120521200],
    ]);
    expect(parseSupplySeries(body, 'd7')).toEqual([]);
  });

  it('reads L2BEAT charts by their column names', () => {
    const rows = parseL2Chart({ types: ['timestamp', 'native', 'canonical', 'external', 'ethPrice'], data: [[1795572000, 9409841011.66, 11045545076.63, 14103728933.85, 1657.16], [1795564800, 9477776566.56, 11142611857.42, 14101239697.69, 1677.88], [null, 1]] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ timestamp: 1795564800000, native: 9477776566.56, canonical: 11142611857.42, external: 14101239697.69, ethPrice: 1677.88 });
    expect(parseL2Chart(undefined)).toEqual([]);
  });

  it('parses L2BEAT projects largest first, without archived ones', () => {
    const rows = parseL2Projects({
      projects: {
        arbitrum: { id: 'arbitrum', name: 'Arbitrum One', category: 'Optimistic Rollup', stage: 'Stage 1', tvs: { breakdown: { total: 8680000000, ether: 1540000000, stablecoin: 4780000000 }, change7d: -0.0531 } },
        base: { id: 'base', name: 'Base Chain', category: 'Optimistic Rollup', stage: 'Stage 1', isArchived: false, tvs: { breakdown: { total: 13263371264, ether: 2032458561, stablecoin: 4429470715 }, change7d: -0.051323553581844705 } },
        old: { id: 'old', name: 'Old Chain', isArchived: true, tvs: { breakdown: { total: 5 } } },
        empty: { id: 'empty', name: 'Empty', tvs: { breakdown: { total: 0 } } },
      },
    });
    expect(rows.map((r) => r.name)).toEqual(['Base Chain', 'Arbitrum One']);
    expect(rows[0]).toMatchObject({ category: 'Optimistic Rollup', stage: 'Stage 1', total: 13263371264, ether: 2032458561, stablecoin: 4429470715 });
    expect(rows[0].change7d).toBeCloseTo(-5.1324, 4);
  });
});

describe('ETFs, treasuries and exchanges', () => {
  it('lists each ticker once', () => {
    for (const items of [BTC_ETFS, ETH_ETFS, CRYPTO_STOCKS, MINERS]) {
      const symbols = items.map((i) => i.symbol);
      expect(new Set(symbols).size).toBe(symbols.length);
      expect(items.every((i) => i.label.length > 0)).toBe(true);
    }
    expect(BTC_ETFS.map((i) => i.symbol)).toEqual(expect.arrayContaining(['IBIT', 'FBTC', 'ARKB', 'BITB', 'GBTC']));
    expect(ETH_ETFS.map((i) => i.symbol)).toEqual(expect.arrayContaining(['ETHA', 'FETH']));
    expect(CRYPTO_STOCKS.map((i) => i.symbol)).toEqual(expect.arrayContaining(['COIN', 'MSTR', 'HOOD']));
    expect(MINERS.map((i) => i.symbol)).toEqual(expect.arrayContaining(['MARA', 'RIOT', 'CLSK']));
  });

  it('parses company treasuries largest first, blanking an undisclosed cost', () => {
    const t = parseTreasuries({
      total_holdings: 1287588.21,
      total_value_usd: 76155724935.9,
      market_cap_dominance: 6.13,
      companies: [
        { name: 'Metaplanet', symbol: '3350.T', country: 'JP', total_holdings: 44000, total_entry_value_usd: 3900000000, total_current_value_usd: 2610000000, percentage_of_total_supply: 0.21 },
        { name: 'Strategy', symbol: 'MSTR.US', country: 'US', total_holdings: 851305.0, total_entry_value_usd: 64227496490.0, total_current_value_usd: 50351306764.9, percentage_of_total_supply: 4.054 },
        { name: 'Twenty One Capital', symbol: 'XXI.US', country: 'US', total_holdings: 43514, total_entry_value_usd: 0, total_current_value_usd: 2580000000, percentage_of_total_supply: 0.207 },
        { name: 'Sold out', total_holdings: 0 },
      ],
    });
    expect(t).toMatchObject({ total: 1287588.21, value: 76155724935.9, dominance: 6.13 });
    expect(t.companies.map((c) => c.name)).toEqual(['Strategy', 'Metaplanet', 'Twenty One Capital']);
    expect(t.companies[0]).toMatchObject({ symbol: 'MSTR.US', holdings: 851305, cost: 64227496490, value: 50351306764.9, supplyPct: 4.054 });
    expect(t.companies[2].cost).toBeNull();
  });

  it('parses spot exchanges by adjusted volume', () => {
    const rows = parseSpotExchanges([
      { id: 'binance', name: 'Binance', active: true, adjusted_rank: 2, currencies: 421, markets: 1206, quotes: { USD: { adjusted_volume_24h: 6630000000, adjusted_volume_7d: 70570000000, adjusted_volume_30d: 226130000000 } }, confidence_score: 0.69 },
      { id: 'bitget', name: 'Bitget', active: true, adjusted_rank: 1, currencies: 556, markets: 616, quotes: { USD: { adjusted_volume_24h: 8418923188.59, adjusted_volume_7d: 76249714311.9, adjusted_volume_30d: 273462418949.3 } }, confidence_score: 0.0792459 },
      { id: 'closed', name: 'Closed', active: false, adjusted_rank: 3, quotes: { USD: { adjusted_volume_24h: 5 } } },
      { id: 'idle', name: 'Idle', active: true, adjusted_rank: null, quotes: { USD: { adjusted_volume_24h: 0 } } },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Bitget', 'Binance']);
    expect(rows[0]).toMatchObject({ rank: 1, volume24h: 8418923188.59, volume30d: 273462418949.3, markets: 616, currencies: 556, confidence: 0.0792459 });
  });

  it('parses derivatives exchanges by open interest', () => {
    const rows = parseDerivExchanges([
      { name: 'OKX (Futures)', id: 'okex_swap', open_interest_btc: 105566.89, trade_volume_24h_btc: '386826.99', number_of_perpetual_pairs: 550, number_of_futures_pairs: 12, year_established: 2021, country: 'United States' },
      { name: 'Binance (Futures)', id: 'binance_futures', open_interest_btc: 417541.78, trade_volume_24h_btc: '1199099.06', number_of_perpetual_pairs: 833, number_of_futures_pairs: 14, year_established: 2019, country: 'Cayman Islands' },
      { name: 'No OI', open_interest_btc: null, trade_volume_24h_btc: '5' },
      { id: 'nameless' },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Binance (Futures)', 'OKX (Futures)', 'No OI']);
    expect(rows[0]).toEqual({ name: 'Binance (Futures)', openInterestBtc: 417541.78, volumeBtc: 1199099.06, perpetuals: 833, futures: 14, country: 'Cayman Islands', year: 2019 });
  });

  it('parses exchange reserves, skipping exchanges with no disclosed wallets', () => {
    const rows = parseReserves({
      cexs: [
        { name: 'OKX', currentTvl: 26151369326.6, cleanAssetsTvl: 26151369326.6, inflows_24h: 60665359.69, inflows_1w: 192873743.19, inflows_1m: 2564052572.57, spotVolume: 1408118326.02, oi: 6258587803.59 },
        { name: 'Binance', currentTvl: 107395364922.26, cleanAssetsTvl: 100000000000, inflows_24h: -260223410.92, inflows_1w: 680525649.7, inflows_1m: -12441225665.1, spotVolume: 7038109844.88, oi: 24743888707.96 },
        { name: 'Coinbase', coin: null },
      ],
    });
    expect(rows.map((r) => r.name)).toEqual(['Binance', 'OKX']);
    expect(rows[0]).toMatchObject({ assets: 107395364922.26, clean: 100000000000, inflow24h: -260223410.92, inflow30d: -12441225665.1, openInterest: 24743888707.96 });
  });
});

describe('news search', () => {
  const items = [
    { title: 'Bitcoin drops as November spot ETF outflows hit a record', link: 'a', source: 'CoinDesk', date: 3 },
    { title: 'Solana tokenized stock volume breaks records', link: 'b', source: 'AMBCrypto', date: 2 },
    { title: 'Grok AI predicts ETH vs SOL for 2027', link: 'c', source: 'Cryptonews', date: 1 },
    { title: 'Solar miners resolve dispute', link: 'd', source: 'Protos', date: 0 },
  ];

  it('matches whole words, and a symbol by its name', () => {
    expect(matchHeadlines(items, 'SOL-USD').map((i) => i.link)).toEqual(['b', 'c']);
    expect(matchHeadlines(items, 'btc').map((i) => i.link)).toEqual(['a']);
    expect(matchHeadlines(items, 'eth').map((i) => i.link)).toEqual(['c']);
    expect(matchHeadlines(items, 'bitcoin etf').map((i) => i.link)).toEqual(['a']);
    expect(matchHeadlines(items, 'c++')).toEqual([]);
    expect(matchHeadlines(items, '  ')).toHaveLength(4);
  });
});
