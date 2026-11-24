/** Parser and helper tests for the CFTC, Deribit, Cboe futures, Coinbase and Kraken sources. */
import { describe, expect, it } from 'vitest';
import { Http } from '../../http.js';
import type { Ctx } from '../../types.js';
import { cotCategories, cotNetChange, cotNetSeries, getCot, isCotCode, parseCotRows } from './cot.js';
import { cumulative, parseCoinbaseCandles, parseCoinbaseStats, parseKrakenOhlc, parseKrakenTicker } from './crypto.js';
import { dailyFunding } from './crypto-vol.js';
import { parseDeribitDate, parseInstrument, parseOptionSummaries } from './deribit.js';
import { contractMonths, parseVxSettlements } from './futures.js';
import { derivativesSearch } from './index.js';
import { MONEYNESS, strikesAround, surfaceRow } from './options.js';
import { buildStrategies } from './options-vol.js';
import type { Chain, OptionQuote } from './chain.js';

describe('CFTC Commitments of Traders', () => {
  const tff = [
    {
      report_date_as_yyyy_mm_dd: '2026-11-10T00:00:00.000',
      contract_market_name: 'E-MINI S&P 500',
      market_and_exchange_names: 'E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE',
      contract_units: '($50 X S&P 500 INDEX)',
      open_interest_all: '2017687',
      dealer_positions_long_all: '175005',
      dealer_positions_short_all: '910294',
      dealer_positions_spread_all: '77560',
      asset_mgr_positions_long: '1115756',
      asset_mgr_positions_short: '201626',
      asset_mgr_positions_spread: '120040',
      lev_money_positions_long: '145755',
      lev_money_positions_short: '448815',
      lev_money_positions_spread: '57885',
      other_rept_positions_long: '68298',
      other_rept_positions_short: '68019',
      other_rept_positions_spread: '303',
      nonrept_positions_long_all: '257085',
      nonrept_positions_short_all: '133145',
    },
    {
      report_date_as_yyyy_mm_dd: '2026-11-17T00:00:00.000',
      contract_market_name: 'E-MINI S&P 500',
      market_and_exchange_names: 'E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE',
      contract_units: '($50 X S&P 500 INDEX)',
      open_interest_all: '2096958',
      dealer_positions_long_all: '189843',
      dealer_positions_short_all: '977219',
      dealer_positions_spread_all: '61838',
      asset_mgr_positions_long: '1122337',
      asset_mgr_positions_short: '227288',
      asset_mgr_positions_spread: '128006',
      lev_money_positions_long: '197833',
      lev_money_positions_short: '432811',
      lev_money_positions_spread: '60963',
      other_rept_positions_long: '70915',
      other_rept_positions_short: '71088',
      other_rept_positions_spread: '366',
      nonrept_positions_long_all: '264857',
      nonrept_positions_short_all: '137379',
    },
    { report_date_as_yyyy_mm_dd: 'bad' },
  ];

  it('parses financial rows newest first with nets', () => {
    const weeks = parseCotRows(tff, 'financial');
    expect(weeks.map((w) => w.date)).toEqual(['2026-11-17', '2026-11-10']);
    expect(weeks[0].openInterest).toBe(2096958);
    expect(weeks[0].positions.dealer).toEqual({ long: 189843, short: 977219, spread: 61838, net: -787376 });
    expect(weeks[0].positions.nonReportable).toEqual({ long: 264857, short: 137379, spread: null, net: 127478 });
    expect(cotNetChange(weeks, 'dealer')).toBe(-787376 - (175005 - 910294));
    expect(cotNetChange(weeks.slice(0, 1), 'dealer')).toBeNull();
    expect(cotNetSeries(weeks, 'leveraged')).toEqual([
      [Date.parse('2026-11-10T00:00:00Z'), 145755 - 448815],
      [Date.parse('2026-11-17T00:00:00Z'), 197833 - 432811],
    ]);
  });

  it('parses disaggregated rows with the portal column names', () => {
    const weeks = parseCotRows(
      [
        {
          report_date_as_yyyy_mm_dd: '2026-11-17T00:00:00.000',
          open_interest_all: '1869789',
          prod_merc_positions_long: '649994',
          prod_merc_positions_short: '264767',
          swap_positions_long_all: '132722',
          swap__positions_short_all: '601471',
          swap__positions_spread_all: '138866',
          m_money_positions_long_all: '153611',
          m_money_positions_short_all: '137797',
          m_money_positions_spread: '286444',
        },
      ],
      'disaggregated',
    );
    expect(weeks[0].positions.producer).toEqual({ long: 649994, short: 264767, spread: null, net: 385227 });
    expect(weeks[0].positions.swapDealer.net).toBe(132722 - 601471);
    expect(weeks[0].positions.managedMoney).toEqual({ long: 153611, short: 137797, spread: 286444, net: 15814 });
    expect(weeks[0].positions.other).toBeUndefined();
    expect(cotCategories('disaggregated').map((c) => c.key)).toEqual(['producer', 'swapDealer', 'managedMoney', 'other', 'nonReportable']);
  });

  it('tells codes from names', () => {
    expect(isCotCode('13874A')).toBe(true);
    expect(isCotCode('13874+')).toBe(true);
    expect(isCotCode('067651')).toBe(true);
    expect(isCotCode('GOLD')).toBe(false);
    expect(isCotCode('UST 10Y NOTE')).toBe(false);
  });

  it('queries by code, and resolves a name to the largest contract first', async () => {
    const urls: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = decodeURIComponent(String(input));
      urls.push(url);
      const body = url.includes('$select=')
        ? [
            { cftc_contract_market_code: '13874U', report_date_as_yyyy_mm_dd: '2026-11-17T00:00:00.000', open_interest_all: '328464' },
            { cftc_contract_market_code: '13874A', report_date_as_yyyy_mm_dd: '2026-11-17T00:00:00.000', open_interest_all: '2096958' },
            { cftc_contract_market_code: '13874A', report_date_as_yyyy_mm_dd: '2026-11-10T00:00:00.000', open_interest_all: '9999999' },
          ]
        : tff;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const ctx: Ctx = { http: new Http({ fetch: fake, hostGapMs: 0 }), key: () => undefined, now: () => new Date('2026-11-24T00:00:00Z') };

    const byCode = await getCot(ctx, { market: '13874a', weeks: 2 });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/gpe5-46if.json?$where=cftc_contract_market_code = '13874A'");
    expect(urls[0]).toContain('$limit=2');
    expect(byCode.market).toBe('E-MINI S&P 500');
    expect(byCode.units).toBe('($50 X S&P 500 INDEX)');
    expect(byCode.weeks).toHaveLength(2);
    expect(byCode.categories[0]).toEqual({ key: 'dealer', label: 'Dealers' });

    urls.length = 0;
    const byName = await getCot(ctx, { market: 's&p 500', report: 'disaggregated', combined: true, weeks: 3 });
    expect(urls[0]).toContain('/kh3c-gbw2.json?$select=');
    expect(urls[0]).toContain("upper(contract_market_name) = 'S&P 500'");
    // Of the codes in the newest report, the one with the most open interest wins.
    expect(urls[1]).toContain("cftc_contract_market_code = '13874A'");
    expect(urls[1]).toContain('$limit=3');
    expect(byName.code).toBe('13874A');
    expect(byName.combined).toBe(true);
    expect(byName.categories.map((c) => c.key)).toContain('managedMoney');
  });
});

describe('Deribit', () => {
  it('parses instrument names', () => {
    expect(parseDeribitDate('26MAR27')).toBe('2027-03-26');
    expect(parseDeribitDate('4DEC26')).toBe('2026-12-04');
    expect(parseDeribitDate('PERPETUAL')).toBeNull();
    expect(parseInstrument('BTC-26MAR27-85000-P')).toEqual({ currency: 'BTC', kind: 'option', expiry: '2027-03-26', strike: 85000, type: 'P' });
    expect(parseInstrument('BTC-29JAN27')).toEqual({ currency: 'BTC', kind: 'future', expiry: '2027-01-29' });
    expect(parseInstrument('ETH-PERPETUAL')).toEqual({ currency: 'ETH', kind: 'perpetual' });
    expect(parseInstrument('XRP_USDC-27NOV26-0d55-C')?.strike).toBe(0.55);
    expect(parseInstrument('NOPE')).toBeNull();
  });

  it('converts coin-quoted option summaries to USD at the forward', () => {
    const out = parseOptionSummaries([
      { instrument_name: 'BTC-29JAN27-90000-C', bid_price: 0.0028, ask_price: 0.0033, last: 0.003, open_interest: 271.1, volume: 0.4, mark_iv: 50.03, underlying_price: 60000 },
      { instrument_name: 'BTC-29JAN27-50000-P', bid_price: null, ask_price: 0, last: null, open_interest: 0, volume: 0, mark_iv: 61, underlying_price: 60000 },
      { instrument_name: 'BTC-29JAN27', mark_price: 60500 },
      { instrument_name: 'BTC-29JAN27-70000-C', bid_price: 0.01, underlying_price: null },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].expiry).toBe('2027-01-29');
    expect(out[0].bid).toBeCloseTo(168, 9);
    expect(out[0].ask).toBeCloseTo(198, 9);
    expect(out[0].ivGiven).toBeCloseTo(0.5003, 9);
    expect(out[0].underlying).toBe(60000);
    expect(out[0].oi).toBe(271.1);
    expect(out[1]).toMatchObject({ type: 'P', strike: 50000, bid: null, ask: null, last: null, ivGiven: 0.61 });
  });

  it('sums hourly funding into UTC days', () => {
    const h = 3_600_000;
    const d0 = Date.parse('2026-11-23T00:00:00Z');
    const out = dailyFunding([
      { timestamp: d0 + 23 * h, interest_1h: 0.00001, index_price: 61000 },
      { timestamp: d0 + 22 * h, interest_1h: 0.00002, index_price: 60900 },
      { timestamp: d0 + 24 * h, interest_1h: -0.00003, index_price: 61100 },
      { timestamp: d0 + 25 * h },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].day).toBe(d0);
    expect(out[0].pct).toBeCloseTo(0.003, 12);
    expect(out[0].hours).toBe(2);
    expect(out[0].index).toBe(61000);
    expect(out[1].pct).toBeCloseTo(-0.003, 12);
  });

  it('accumulates book depth away from the touch', () => {
    expect(cumulative([[100, 5], [99.5, 10], [99, 1]])).toEqual([[100, 5], [99.5, 15], [99, 16]]);
  });
});

describe('Cboe VIX futures settlements', () => {
  it('keeps VX rows, flags weeklies and sorts by expiry', () => {
    const csv = 'Product,Symbol,Expiration Date,Price\nVX,VX/F7,2027-01-20,23.7164\nVX,VX48/Z6,2026-12-01,24.0844\nVX,VX/Z6,2026-12-16,24.0844\nVXM,VXM/Z6,2026-12-16,24.0844\nVA,VA/Z6,2026-12-18,219.25\n';
    expect(parseVxSettlements(csv)).toEqual([
      { symbol: 'VX48/Z6', expiry: '2026-12-01', price: 24.0844, weekly: true },
      { symbol: 'VX/Z6', expiry: '2026-12-16', price: 24.0844, weekly: false },
      { symbol: 'VX/F7', expiry: '2027-01-20', price: 23.7164, weekly: false },
    ]);
    expect(parseVxSettlements('Product,Symbol,Expiration Date,Price\n')).toEqual([]);
  });

  it('builds dated contract symbols across a year end', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    expect(contractMonths('ZQ', 'CBT', now, 3)).toEqual([
      { symbol: 'ZQX26.CBT', month: '2026-11' },
      { symbol: 'ZQZ26.CBT', month: '2026-12' },
      { symbol: 'ZQF27.CBT', month: '2027-01' },
    ]);
    expect(contractMonths('CL', 'NYM', now, 2, 1).map((c) => c.symbol)).toEqual(['CLZ26.NYM', 'CLF27.NYM']);
  });
});

describe('spot exchanges', () => {
  it('parses Coinbase 24-hour statistics for the wanted pairs', () => {
    const out = parseCoinbaseStats(
      {
        'BTC-USD': { stats_24hour: { open: '63786.6', high: '64533.96', low: '59300.01', last: '60078.14', volume: '16880.85' } },
        'BTC-EUR': { stats_24hour: { open: '1', high: '1', low: '1', last: '1', volume: '1' } },
        'ETH-USD': { stats_24hour: { open: '1800', last: '0', volume: '5' } },
      },
      ['BTC', 'ETH', 'SOL'],
    );
    expect(out).toEqual([{ pair: 'BTC-USD', last: 60078.14, open: 63786.6, high: 64533.96, low: 59300.01, volume: 16880.85 }]);
  });

  it('parses a Kraken ticker with renamed pairs', () => {
    const out = parseKrakenTicker(
      {
        error: [],
        result: {
          XXBTZUSD: { c: ['60061.2', '0.001'], v: ['2084.3', '5966.2'], l: ['59314.1', '59300.0'], h: ['61592.2', '64520.3'], o: '61199.3' },
          SOLUSD: { c: ['69.8', '1'], v: ['10', '20'], l: ['69', '68'], h: ['75', '78'], o: '76.5' },
        },
      },
      ['BTC', 'SOL', 'ETH'],
    );
    expect(out).toEqual([
      { pair: 'BTC-USD', last: 60061.2, open: 61199.3, high: 64520.3, low: 59300, volume: 5966.2 },
      { pair: 'SOL-USD', last: 69.8, open: 76.5, high: 78, low: 68, volume: 20 },
    ]);
  });

  it('parses daily candles from both exchanges, oldest first', () => {
    expect(parseCoinbaseCandles([[1795478400, 59300.01, 61603.49, 61190.81, 60048, 5938.98], [1795392000, 60286.92, 64533.96, 61163.01, 61189.97, 16914.31]])).toEqual([
      [1795392000000, 61189.97, 16914.31],
      [1795478400000, 60048, 5938.98],
    ]);
    expect(parseCoinbaseCandles({ message: 'NotFound' })).toEqual([]);
    expect(parseKrakenOhlc({ error: [], result: { XXBTZUSD: [[1795305600, '60089.9', '61590.0', '58649.8', '61170.1', '60291.3', '2969.77', 132150]], last: 1795392000 } })).toEqual([
      [1795305600000, 61170.1, 2969.77],
    ]);
    expect(parseKrakenOhlc({ error: ['EQuery:Unknown asset pair'] })).toEqual([]);
  });
});

describe('option card helpers', () => {
  const q = (type: 'C' | 'P', strike: number, mid: number | null, iv: number | null, last: number | null = mid): OptionQuote => ({
    expiry: '2026-12-18',
    strike,
    type,
    bid: mid === null ? null : mid - 0.05,
    ask: mid === null ? null : mid + 0.05,
    last,
    volume: 1,
    oi: 1,
    mid,
    iv,
    delta: null,
    gamma: null,
    vega: null,
    theta: null,
  });
  const quotes = [
    q('P', 90, 0.5, 0.4),
    q('P', 95, 1.2, 0.34),
    q('C', 95, 6.4, 0.34),
    q('P', 100, 3, 0.3),
    q('C', 100, 3.2, 0.3),
    q('C', 105, 1.1, 0.27),
    q('P', 105, 6, 0.27),
    q('C', 110, null, null, 0.3),
  ];

  it('prices the standard strategies from mids, falling back to last', () => {
    const list = buildStrategies(quotes, 100);
    expect(list.map((s) => s.id)).toEqual(['straddle', 'strangle', 'call-spread', 'put-spread']);
    const straddle = list[0];
    expect(straddle.legsText).toBe('+100C +100P');
    expect(straddle.cost).toBeCloseTo(6.2, 9);
    expect(straddle.breakevens).toEqual([93.8, 106.2]);
    expect(straddle.movePct).toBeCloseTo(6.2, 9);
    expect(straddle.maxProfit).toBeNull();
    expect(straddle.maxLoss).toBeCloseTo(-6.2, 9);
    expect(straddle.usedLast).toBe(false);
    const strangle = list[1];
    expect(strangle.legsText).toBe('+95P +105C');
    expect(strangle.cost).toBeCloseTo(2.3, 9);
    const spread = list[2];
    expect(spread.legsText).toBe('+100C -105C');
    expect(spread.cost).toBeCloseTo(2.1, 9);
    expect(spread.maxProfit).toBeCloseTo(2.9, 9);
    expect(spread.maxLoss).toBeCloseTo(-2.1, 9);
    expect(spread.breakevens).toEqual([102.1]);
    expect(list[3].legsText).toBe('+100P -95P');
    expect(list[3].breakevens).toEqual([98.2]);
  });

  it('leaves out strategies it cannot price', () => {
    expect(buildStrategies(quotes.filter((x) => x.type === 'C'), 100)).toEqual([]);
    const wide = buildStrategies(quotes, 100, 0.08);
    expect(wide.find((s) => s.id === 'strangle')?.legsText).toBe('+90P +110C');
    expect(wide.find((s) => s.id === 'strangle')?.usedLast).toBe(true);
  });

  it('windows strikes around the money and fills a surface row', () => {
    expect(strikesAround(quotes, 100, 1)).toEqual([95, 100, 105]);
    expect(strikesAround(quotes, null, 1)).toEqual([90, 95, 100]);
    const chain = { quotes, spot: 100, expiries: ['2026-12-18'], multiplier: 100 } as unknown as Chain;
    const row = surfaceRow(chain, '2026-12-18');
    const at = (m: number): number | null => row[MONEYNESS.indexOf(m)];
    expect(at(90)).toBeCloseTo(40, 9);
    expect(at(95)).toBeCloseTo(34, 9);
    expect(at(100)).toBeCloseTo(30, 9);
    expect(at(105)).toBeCloseTo(27, 9);
    expect(at(80)).toBeNull();
    expect(at(110)).toBeNull();
  });
});

describe('search', () => {
  it('routes coins, positioning contracts and option-chain requests', () => {
    expect(derivativesSearch('btc').map((h) => `${h.dashboard}/${h.tab}`)).toEqual(['crypto/spot', 'crypto/options', 'futures/positioning']);
    expect(derivativesSearch('nasdaq')[0]).toMatchObject({ dashboard: 'futures', tab: 'positioning', params: { series: 'nasdaq100' } });
    expect(derivativesSearch('aapl options')[0]).toMatchObject({ dashboard: 'options', tab: 'chain', params: { symbol: 'AAPL' } });
    expect(derivativesSearch('aapl')).toEqual([]);
    expect(derivativesSearch('  ')).toEqual([]);
  });
});
