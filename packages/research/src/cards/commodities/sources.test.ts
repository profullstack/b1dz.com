/** Parsers on small fixtures shaped like each provider's response. */
import { describe, expect, it } from 'vitest';
import { currentMarketYear, marketYearLabel, parseBls, parsePsdWorld } from './agri.js';
import { areaByCountry, areaByCurrency, bisPoints, parseBisCsv } from './bis.js';
import { alignPoints, eiaPath, eiaPoints, parseEiaBody } from './eia.js';
import { mmcfToBcfd } from './energy-oil.js';
import { byCountry } from './energy-power.js';
import { crackSpreads } from './energy-prices.js';
import { contractChain, ROOTS } from './futures.js';
import { imfPoints, parseImfCsv } from './imf.js';
import { netPercentile } from './positioning.js';
import { searchStatic } from './search.js';

describe('EIA', () => {
  it('builds a deterministic request path', () => {
    const url = eiaPath('/petroleum/pri/spt/', { frequency: 'daily', facets: { series: ['RWTC', 'RBRTE'] }, start: '2024-11-01' });
    expect(url).toBe(
      'https://api.eia.gov/v2/petroleum/pri/spt/data/?frequency=daily&data[0]=value&facets[series][]=RWTC&facets[series][]=RBRTE&start=2024-11-01&sort[0][column]=period&sort[0][direction]=desc&length=5000',
    );
    expect(eiaPath('steo', { data: ['capacity', 'outage'], length: 9999 })).toContain('data[0]=capacity&data[1]=outage&sort');
    expect(eiaPath('steo', { length: 9999 })).toContain('length=5000');
  });

  const body = {
    response: {
      total: '4',
      data: [
        { period: '2026-11-17', series: 'RWTC', value: '89.53', units: '$/BBL' },
        { period: '2026-11-17', series: 'RBRTE', value: 92.94, units: '$/BBL' },
        { period: '2026-11-16', series: 'RWTC', value: '89.24', units: '$/BBL' },
        { period: '2026-11-16', series: 'RBRTE', value: null, units: '$/BBL' },
      ],
    },
  };

  it('parses rows, sorts points oldest first and drops missing values', () => {
    const rows = parseEiaBody(body, 'petroleum/pri/spt');
    expect(eiaPoints(rows, 'series', 'RWTC')).toEqual([
      [Date.UTC(2026, 10, 16), 89.24],
      [Date.UTC(2026, 10, 17), 89.53],
    ]);
    expect(eiaPoints(rows, 'series', 'RBRTE')).toEqual([[Date.UTC(2026, 10, 17), 92.94]]);
  });

  it('reads hourly and monthly periods', () => {
    const rows = [
      { period: '2026-11-24T13', type: 'D', value: '476012' },
      { period: '2026-08', type: 'M', value: '10' },
    ];
    expect(eiaPoints(rows, 'type', 'D')).toEqual([[Date.UTC(2026, 10, 24, 13), 476012]]);
    expect(eiaPoints(rows, 'type', 'M')).toEqual([[Date.UTC(2026, 7, 1), 10]]);
  });

  it('throws on an error body and on an empty result', () => {
    expect(() => parseEiaBody({ error: { code: 'OVER_RATE_LIMIT', message: 'You have exceeded your rate limit.' } }, 'x')).toThrow(/rate limit/);
    expect(() => parseEiaBody({ response: { data: [] } }, 'x')).toThrow(/no rows/);
    expect(() => parseEiaBody('nope', 'x')).toThrow(/unexpected/);
  });

  it('aligns series on common dates', () => {
    expect(
      alignPoints([
        [
          [1, 10],
          [2, 20],
          [3, 30],
        ],
        [
          [2, 5],
          [3, 6],
          [4, 7],
        ],
      ]),
    ).toEqual([
      { t: 2, v: [20, 5] },
      { t: 3, v: [30, 6] },
    ]);
  });

  it('computes crack spreads per barrel', () => {
    const c = crackSpreads(80, 2.5, 3);
    expect(c.gasoline).toBeCloseTo(25, 10);
    expect(c.distillate).toBeCloseTo(46, 10);
    expect(c.c321).toBeCloseTo((2 * 105 + 126) / 3 - 80, 10);
  });

  it('converts monthly million cubic feet to billion cubic feet a day', () => {
    expect(mmcfToBcfd(Date.UTC(2026, 7, 1), 3_100_000)).toBeCloseTo(100, 10); // August: 31 days
    expect(mmcfToBcfd(Date.UTC(2024, 1, 1), 2_900_000)).toBeCloseTo(100, 10); // leap February
  });

  it('groups international rows by country', () => {
    const got = byCountry([
      { period: '2026-07', countryRegionId: 'USA', countryRegionName: 'United States', value: '13900' },
      { period: '2026-06', countryRegionId: 'USA', countryRegionName: 'United States', value: 13800 },
      { period: '2025', countryRegionId: 'SAU', countryRegionName: 'Saudi Arabia', value: '7000' },
      { period: '2026-07', countryRegionId: 'XXX', countryRegionName: 'Nowhere', value: '--' },
    ]);
    expect(got).toHaveLength(2);
    expect(got[0].pts).toEqual([
      [Date.UTC(2026, 5, 1), 13800],
      [Date.UTC(2026, 6, 1), 13900],
    ]);
    expect(got[1].pts).toEqual([[Date.UTC(2025, 0, 1), 7000]]);
  });
});

describe('IMF SDMX CSV', () => {
  const csv = [
    'DATAFLOW,COUNTRY,INDICATOR,DATA_TRANSFORMATION,FREQUENCY,TIME_PERIOD,OBS_VALUE,SCALE,FULL_DESCRIPTION',
    'IMF.RES:PCPS(9.0.0),,,,,,,,"PCPS database includes 70+ commodities, with ""quoted"" text"',
    'IMF.RES:PCPS(9.0.0),G001,PGOLD,USD,M,2026-M09,4326.9,0,',
    'IMF.RES:PCPS(9.0.0),G001,PGOLD,USD,M,2026-M10,4102.37,0,',
    'IMF.RES:PCPS(9.0.0),G001,PCOPP,USD,M,2026-M10,14507.97,0,',
    'IMF.STA:COFER(7.0.1),G001,AFXRA,USD,Q,2026-Q2,56.7,0,',
  ].join('\n');

  it('drops the metadata row and reads monthly and quarterly periods', () => {
    const rows = parseImfCsv(csv);
    expect(rows).toHaveLength(4);
    expect(imfPoints(rows, { INDICATOR: 'PGOLD', FREQUENCY: 'M' })).toEqual([
      [Date.UTC(2026, 8, 1), 4326.9],
      [Date.UTC(2026, 9, 1), 4102.37],
    ]);
    expect(imfPoints(rows, { INDICATOR: 'AFXRA' })).toEqual([[Date.UTC(2026, 3, 1), 56.7]]);
    expect(imfPoints(rows, { INDICATOR: 'NOPE' })).toEqual([]);
  });
});

describe('BIS CSV', () => {
  const csv = [
    'FREQ,REF_AREA,UNIT_MEASURE,TITLE,TIME_PERIOD,OBS_VALUE,OBS_STATUS',
    'D,AU,368,"Central bank policy rates - Australia - Daily, end of period",2026-11-11,4.85,A',
    'D,AU,368,"Central bank policy rates - Australia - Daily, end of period",2026-11-12,4.85,A',
    'M,US,368,Central bank policy rates - United States,2026-10,3.875,A',
    'M,US,368,Central bank policy rates - United States,2026-11,NaN,A',
  ].join('\n');

  it('reads daily and monthly observations and skips NaN', () => {
    const rows = parseBisCsv(csv);
    expect(bisPoints(rows, { REF_AREA: 'AU' })).toEqual([
      [Date.UTC(2026, 10, 11), 4.85],
      [Date.UTC(2026, 10, 12), 4.85],
    ]);
    expect(bisPoints(rows, { REF_AREA: 'US', FREQ: 'M' })).toEqual([[Date.UTC(2026, 9, 1), 3.875]]);
  });

  it('maps currencies and country codes to reference areas', () => {
    expect(areaByCurrency('eur')?.code).toBe('XM');
    expect(areaByCountry('EU')?.code).toBe('XM');
    expect(areaByCountry('uk')?.code).toBe('GB');
    expect(areaByCountry('jp')?.currency).toBe('JPY');
    expect(areaByCountry('ZZ')).toBeUndefined();
  });
});

describe('USDA PSD', () => {
  const body = [
    { commodityCode: '0440000', countryCode: '00', marketYear: '2026', calendarYear: '2026', month: '11', attributeId: 4, unitId: 4, value: 213506 },
    { commodityCode: '0440000', countryCode: '00', marketYear: '2026', calendarYear: '2026', month: '11', attributeId: 20, unitId: 8, value: 308310 },
    { commodityCode: '0440000', countryCode: '00', marketYear: '2026', calendarYear: '2026', month: '11', attributeId: 28, unitId: 8, value: 1291550 },
    { commodityCode: '0440000', countryCode: '00', marketYear: '2026', calendarYear: '2026', month: '11', attributeId: 125, unitId: 8, value: 1309964 },
    { commodityCode: '0440000', countryCode: '00', marketYear: '2026', calendarYear: '2026', month: '11', attributeId: 176, unitId: 8, value: 281938 },
    { commodityCode: '0440000', countryCode: '00', marketYear: '2026', calendarYear: '2026', month: '11', attributeId: 81, unitId: 8, value: 202371 },
  ];

  it('reads a world balance and computes stocks-to-use', () => {
    const b = parsePsdWorld(body, 2026);
    expect(b.values).toEqual({ area: 213506, beginning: 308310, production: 1291550, consumption: 1309964, ending: 281938 });
    expect(b.month).toBe(11);
    expect(b.year).toBe(2026);
    expect(b.stocksToUse).toBeCloseTo((281938 / 1309964) * 100, 10);
  });

  it('rejects an empty year and a non-array body', () => {
    expect(() => parsePsdWorld([], 2030)).toThrow(/2030/);
    expect(() => parsePsdWorld({ message: 'An error has occurred.' }, 2026)).toThrow(/unexpected/);
  });

  it('labels and picks marketing years', () => {
    expect(marketYearLabel(2026)).toBe('2026/27');
    expect(marketYearLabel(1999)).toBe('1999/00');
    expect(currentMarketYear(new Date(Date.UTC(2026, 3, 30)))).toBe(2025);
    expect(currentMarketYear(new Date(Date.UTC(2026, 4, 1)))).toBe(2026);
  });
});

describe('BLS', () => {
  it('reads monthly values, skipping annual averages and missing months', () => {
    const got = parseBls({
      status: 'REQUEST_SUCCEEDED',
      Results: {
        series: [
          {
            seriesID: 'WPU01',
            data: [
              { year: '2026', period: 'M10', value: '239.504' },
              { year: '2026', period: 'M09', value: '236.600' },
              { year: '2025', period: 'M13', value: '230.1' },
              { year: '2025', period: 'M10', value: '-' },
            ],
          },
          { seriesID: 'EMPTY', data: [] },
        ],
      },
    });
    expect(got.get('WPU01')).toEqual([
      [Date.UTC(2026, 8, 1), 236.6],
      [Date.UTC(2026, 9, 1), 239.504],
    ]);
    expect(got.has('EMPTY')).toBe(false);
  });

  it('surfaces a failed request', () => {
    expect(() => parseBls({ status: 'REQUEST_NOT_PROCESSED', message: ['daily threshold reached'] })).toThrow(/daily threshold/);
  });
});

describe('futures contract chain', () => {
  it('lists the next contracts after the spot month in the exchange-suffix convention', () => {
    const chain = contractChain(ROOTS.CL, new Date(Date.UTC(2026, 10, 24)), 3);
    expect(chain.map((c) => c.symbol)).toEqual(['CLZ26.NYM', 'CLF27.NYM', 'CLG27.NYM']);
    expect(chain[0].label).toBe('Dec 2026');
    expect(chain[0].month).toBe(Date.UTC(2026, 11, 1));
  });

  it('keeps to the listed delivery months', () => {
    expect(contractChain(ROOTS.ZC, new Date(Date.UTC(2026, 10, 24)), 4).map((c) => c.symbol)).toEqual(['ZCZ26.CBT', 'ZCH27.CBT', 'ZCK27.CBT', 'ZCN27.CBT']);
    expect(contractChain(ROOTS.GC, new Date(Date.UTC(2026, 11, 15)), 2).map((c) => c.symbol)).toEqual(['GCG27.CMX', 'GCJ27.CMX']);
  });
});

describe('positioning percentile', () => {
  const weeks = (nets: number[]): { weeks: { date: string; openInterest: null; positions: Record<string, { long: number; short: number; spread: null; net: number }> }[] } => ({
    weeks: nets.map((net, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, openInterest: null, positions: { managedMoney: { long: 0, short: 0, spread: null, net } } })),
  });

  it('ranks the newest week (first) within the history', () => {
    expect(netPercentile(weeks([50, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 'managedMoney')).toBe(100);
    expect(netPercentile(weeks([-5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 'managedMoney')).toBeCloseTo(100 / 12, 10);
  });

  it('needs enough history', () => {
    expect(netPercentile(weeks([1, 2, 3]), 'managedMoney')).toBeNull();
    expect(netPercentile(weeks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'other')).toBeNull();
  });
});

describe('search', () => {
  it('finds pairs, currencies and commodities', () => {
    expect(searchStatic('eur/usd')[0]).toMatchObject({ dashboard: 'fx', tab: 'rates', params: { symbol: 'EURUSD' } });
    expect(searchStatic('jpy')[0]).toMatchObject({ params: { symbol: 'USDJPY' } });
    expect(searchStatic('copper')[0]).toMatchObject({ dashboard: 'commodities', params: { series: 'PCOPP' } });
    expect(searchStatic('soybeans')[0]).toMatchObject({ dashboard: 'agri', params: { series: 'PSOYB' } });
    expect(searchStatic('wasde')[0]).toMatchObject({ dashboard: 'agri', tab: 'balances' });
    expect(searchStatic('x')).toEqual([]);
  });
});
