import { describe, expect, it } from 'vitest';
import { findCountries, MONITOR, nameOf, resolveEconomy } from './countries.js';
import { byArea, imfPoints, mean, parseImfValues, parseSdmxCsv, periodToMs, rangeStartMs } from './data.js';
import { imfValue } from './economy.js';
import { parseDataflows, parseFredSearch, splitSeries } from './explorers.js';
import { macroHits, TOPICS } from './search.js';

describe('periodToMs', () => {
  it('reads annual, quarterly, monthly and daily periods', () => {
    expect(periodToMs('2026')).toBe(Date.UTC(2026, 0, 1));
    expect(periodToMs('2026-Q3')).toBe(Date.UTC(2026, 6, 1));
    expect(periodToMs('2026-10')).toBe(Date.UTC(2026, 9, 1));
    expect(periodToMs('2026-11-16')).toBe(Date.UTC(2026, 10, 16));
  });
  it('rejects anything else', () => {
    expect(periodToMs('2026-13')).toBeNull();
    expect(periodToMs('Nov 2026')).toBeNull();
    expect(periodToMs('')).toBeNull();
  });
});

const OECD_CSV = `STRUCTURE,STRUCTURE_ID,ACTION,REF_AREA,FREQ,MEASURE,TIME_PERIOD,OBS_VALUE,OBS_STATUS
DATAFLOW,TEST:DF(1.0),I,DEU,M,LI,2026-10,101.5,A
DATAFLOW,TEST:DF(1.0),I,DEU,M,LI,2026-09,101.0,A
DATAFLOW,TEST:DF(1.0),I,USA,M,LI,2026-10,100.9,A
DATAFLOW,TEST:DF(1.0),I,USA,M,LI,2026-09,,M
DATAFLOW,TEST:DF(1.0),I,USA,M,LI,2026-08,NaN,M
`;

const BIS_CSV = `STRUCTURE,STRUCTURE_ID,ACTION,FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE,TITLE,COMPILATION
dataflow,BIS:WS_TEST(1.0),I,D,GB,2026-11-16,4,"Policy rates - United Kingdom","From 2006 onwards: official bank rate; before: repo rate."
dataflow,BIS:WS_TEST(1.0),I,D,GB,2026-11-13,4.25,"Policy rates - United Kingdom","From 2006 onwards: official bank rate; before: repo rate."
`;

describe('parseSdmxCsv', () => {
  it('returns observations oldest first and skips empty or NaN values', () => {
    const obs = parseSdmxCsv(OECD_CSV);
    expect(obs.map((o) => [o.area, o.period, o.value])).toEqual([
      ['DEU', '2026-09', 101],
      ['DEU', '2026-10', 101.5],
      ['USA', '2026-10', 100.9],
    ]);
    expect(obs[0].t).toBe(Date.UTC(2026, 8, 1));
  });
  it('keeps every column, including quoted text with commas', () => {
    const obs = parseSdmxCsv(BIS_CSV);
    expect(obs).toHaveLength(2);
    expect(obs[1]).toMatchObject({ area: 'GB', period: '2026-11-16', value: 4 });
    expect(obs[1].dims.COMPILATION).toBe('From 2006 onwards: official bank rate; before: repo rate.');
  });
  it('groups by area', () => {
    const g = byArea(parseSdmxCsv(OECD_CSV));
    expect([...g.keys()]).toEqual(['DEU', 'USA']);
    expect(g.get('DEU')?.map((o) => o.value)).toEqual([101, 101.5]);
  });
  it('can key on another column', () => {
    const csv = 'KEY,FREQ,TIME_PERIOD,OBS_VALUE,TITLE\nEXR.D.USD.EUR.SP00.A,D,2026-11-20,1.099,US dollar/Euro\n';
    expect(parseSdmxCsv(csv, 'KEY')[0].area).toBe('EXR.D.USD.EUR.SP00.A');
  });
});

describe('splitSeries', () => {
  it('builds a key from the dimension columns between ACTION and TIME_PERIOD', () => {
    const s = splitSeries(parseSdmxCsv(OECD_CSV));
    expect(s.map((x) => x.key)).toEqual(['DEU.M.LI', 'USA.M.LI']);
    expect(s[0].points).toEqual([[Date.UTC(2026, 8, 1), 101], [Date.UTC(2026, 9, 1), 101.5]]);
    expect(s[0].periods).toEqual(['2026-09', '2026-10']);
  });
  it('uses the KEY column and the title when the source provides them', () => {
    const csv = 'KEY,FREQ,TIME_PERIOD,OBS_VALUE,TITLE\nEXR.D.USD.EUR.SP00.A,D,2026-11-20,1.099,US dollar/Euro\n';
    expect(splitSeries(parseSdmxCsv(csv, 'KEY'))[0]).toMatchObject({ key: 'EXR.D.USD.EUR.SP00.A', title: 'US dollar/Euro' });
  });
});

const IMF = { values: { TEST_IND: { USA: { '2024': 2.8, '2025': 2.0, '2026': 2.3, bad: 1 }, EURO: { '2025': 1.2, '2026': null }, XXX: null } } };

describe('IMF DataMapper', () => {
  const table = parseImfValues(IMF, 'TEST_IND');
  it('keeps numeric year values only', () => {
    expect(table.USA).toEqual({ '2024': 2.8, '2025': 2.0, '2026': 2.3 });
    expect(table.EURO).toEqual({ '2025': 1.2 });
    expect(table.XXX).toBeUndefined();
    expect(parseImfValues({}, 'TEST_IND')).toEqual({});
    expect(parseImfValues(IMF, 'OTHER')).toEqual({});
  });
  it('turns a row into yearly points within a range', () => {
    expect(imfPoints(table, 'USA', 2025)).toEqual([[Date.UTC(2025, 0, 1), 2.0], [Date.UTC(2026, 0, 1), 2.3]]);
    expect(imfPoints(table, 'USA', 0, 2024)).toEqual([[Date.UTC(2024, 0, 1), 2.8]]);
    expect(imfPoints(table, 'NOPE')).toEqual([]);
  });
  it('falls back to the nearest earlier year, within three years', () => {
    expect(imfValue(table, 'USA', 2026)).toEqual({ value: 2.3, year: 2026 });
    expect(imfValue(table, 'EURO', 2026)).toEqual({ value: 1.2, year: 2025 });
    expect(imfValue(table, 'EURO', 2029)).toBeNull();
    expect(imfValue(table, 'NOPE', 2026)).toBeNull();
  });
});

describe('mean and rangeStartMs', () => {
  it('averages, and is null for no values', () => {
    expect(mean([1, 2, 6])).toBe(3);
    expect(mean([])).toBeNull();
  });
  it('counts months and years back from now', () => {
    const now = new Date(Date.UTC(2026, 10, 24, 13, 0));
    expect(rangeStartMs('1M', now)).toBe(Date.UTC(2026, 9, 24));
    expect(rangeStartMs('5Y', now)).toBe(Date.UTC(2021, 10, 24));
    expect(rangeStartMs('MAX', now)).toBe(Date.UTC(1900, 0, 1));
    expect(rangeStartMs('nonsense', now, '2Y')).toBe(Date.UTC(2024, 10, 24));
    expect(rangeStartMs(undefined, now, '10Y')).toBe(Date.UTC(2016, 10, 24));
  });
});

describe('countries', () => {
  it('lists 17 monitor economies with distinct ISO-2 codes', () => {
    expect(MONITOR).toHaveLength(17);
    expect(new Set(MONITOR.map((m) => m.iso2)).size).toBe(17);
  });
  it('resolves ISO-2, ISO-3 and euro-area aliases', () => {
    expect(resolveEconomy('de')).toMatchObject({ iso2: 'DE', imf: 'DEU', bis: 'XM', oecd: 'DEU' });
    expect(resolveEconomy('JPN')).toMatchObject({ iso2: 'JP', bis: 'JP' });
    expect(resolveEconomy('EA')).toMatchObject({ iso2: 'XM', imf: 'EURO', oecd: 'EA20' });
    expect(resolveEconomy(undefined).iso2).toBe('US');
  });
  it('maps other euro members to the ECB and passes unknown ISO-3 codes through', () => {
    expect(resolveEconomy('NL')).toMatchObject({ iso3: 'NLD', bis: 'XM' });
    expect(resolveEconomy('PL')).toMatchObject({ iso3: 'POL', bis: 'PL' });
    expect(resolveEconomy('KEN')).toMatchObject({ imf: 'KEN', name: 'KEN' });
    expect(() => resolveEconomy('Germany!')).toThrow(/ISO-2/);
  });
  it('names codes and finds countries by name', () => {
    expect(nameOf('DEU')).toBe('Germany');
    expect(nameOf('EA20')).toBe('Euro area');
    expect(nameOf('ZZZ')).toBe('ZZZ');
    expect(findCountries('germany')).toEqual([{ iso2: 'DE', name: 'Germany' }]);
    expect(findCountries('uk')).toEqual([{ iso2: 'GB', name: 'United Kingdom' }]);
    expect(findCountries('eurozone')[0]).toEqual({ iso2: 'XM', name: 'Euro area' });
    expect(findCountries('x')).toEqual([]);
  });
});

describe('explorer parsers', () => {
  it('reads a FRED series search response', () => {
    const rows = parseFredSearch({
      seriess: [
        { id: 'UNRATE', title: 'Unemployment Rate', frequency_short: 'M', units_short: '%', seasonal_adjustment_short: 'SA', observation_end: '2026-10-01', popularity: 94 },
        { title: 'No id' },
      ],
    });
    expect(rows).toEqual([{ id: 'UNRATE', title: 'Unemployment Rate', freq: 'M', units: '%', sa: 'SA', last: '2026-10-01', popularity: 94 }]);
    expect(parseFredSearch({})).toEqual([]);
  });
  it('reads dataflows from an SDMX structure message', () => {
    const xml = `<message:Structure><message:Structures><structure:Dataflows>
      <structure:Dataflow id="DSD_A@DF_ONE" agencyID="OECD.X" version="1.2" isFinal="true"><common:Name xml:lang="fr">Un</common:Name><common:Name xml:lang="en">One &amp; only</common:Name></structure:Dataflow>
      <structure:Dataflow id="DF_TWO" agencyID="OECD.Y" version="2.0"><common:Name xml:lang="en">Two</common:Name></structure:Dataflow>
    </structure:Dataflows></message:Structures></message:Structure>`;
    expect(parseDataflows(xml)).toEqual([
      { ref: 'OECD.X,DSD_A@DF_ONE,1.2', name: 'One & only' },
      { ref: 'OECD.Y,DF_TWO,2.0', name: 'Two' },
    ]);
  });
});

describe('macroHits', () => {
  const first = (q: string) => macroHits(q)[0];
  it('routes dataset keywords to the right dashboard and tab', () => {
    expect(first('cpi')).toMatchObject({ kind: 'dataset', dashboard: 'us-economy', tab: 'prices' });
    expect(first('payrolls')).toMatchObject({ dashboard: 'us-economy', tab: 'labor' });
    expect(first('sofr')).toMatchObject({ dashboard: 'rates', tab: 'money-markets' });
    expect(first('wasde')).toMatchObject({ dashboard: 'agri', tab: 'balances' });
    expect(first('hormuz')).toMatchObject({ dashboard: 'trade', tab: 'chokepoints' });
    expect(macroHits('gdp').map((h) => `${h.dashboard}/${h.tab}`)).toEqual(expect.arrayContaining(['us-economy/nowcasts', 'economy/monitor']));
  });
  it('turns a country name into country pages with the country param', () => {
    const hits = macroHits('Japan');
    expect(hits[0]).toMatchObject({ dashboard: 'economy', tab: 'monitor', params: { country: 'JP' } });
    expect(hits.some((h) => h.dashboard === 'news' && h.tab === 'regional' && h.params?.country === 'JP')).toBe(true);
  });
  it('ranks exact keywords above prefixes and returns nothing for noise', () => {
    expect(first('trade').tab).toBe('trade');
    expect(first('payr').tab).toBe('labor');
    expect(macroHits('zzzz')).toEqual([]);
    expect(macroHits('a')).toEqual([]);
  });
  it('can drop hits to dashboards the caller does not have', () => {
    expect(macroHits('sofr', new Set(['economy']))).toEqual([]);
  });
  it('has lower-case keys and a dashboard on every topic', () => {
    for (const t of TOPICS) {
      expect(t.dashboard).not.toBe('');
      for (const k of t.keys) expect(k).toBe(k.toLowerCase());
    }
  });
});
