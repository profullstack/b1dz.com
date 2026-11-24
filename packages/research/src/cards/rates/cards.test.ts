import { describe, expect, it } from 'vitest';
import { fdicDate, peerGroup, peerTable } from './banking.js';
import { cdsIndexLevels, latestAnnualFact, quoteScale, spreadStats } from './credit.js';
import { auctionRate, pdSeries } from './govfin.js';
import { rates, searchRates } from './index.js';
import { parseHorizons, parsePolicyCsv, rateChanges } from './rates-country.js';
import { refSeries, repoRows } from './rates-euro-mm.js';
import { htmlText, parseFedRss, parseFomcCalendar, parsePressRelease, swapPrints, swapTenorSummary, type SdrTrade } from './rates-swaps-policy.js';
import { billSeries, spreadSeries } from './rates-us.js';
import { parseTreasuryCsv } from './curves.js';
import { DAY } from './util.js';

describe('module shape', () => {
  it('has unique card ids and no dashboard pointing at a missing card', () => {
    const ids = rates.cards.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const onTabs = rates.dashboards.flatMap((d) => d.tabs.flatMap((t) => t.cards));
    for (const id of onTabs) expect(ids).toContain(id);
    for (const id of ids) expect(onTabs).toContain(id);
  });

  it('gives every param a default and uses the agreed groups', () => {
    for (const c of rates.cards) for (const p of c.params ?? []) expect(p.default, `${c.id}.${p.name}`).toBeDefined();
    expect(rates.dashboards.map((d) => [d.id, d.group])).toEqual([
      ['rates', 'Rates & Credit'],
      ['credit', 'Rates & Credit'],
      ['govfin', 'Rates & Credit'],
      ['banking', 'Macro & Economy'],
    ]);
  });

  it('finds countries by name or code', () => {
    expect(searchRates('japan')[0]).toMatchObject({ dashboard: 'rates', tab: 'country', params: { country: 'JP' } });
    expect(searchRates('se')[0].params).toEqual({ country: 'SE' });
    expect(searchRates('x')).toEqual([]);
    expect(searchRates('zzzz')).toEqual([]);
  });
});

describe('policy rates', () => {
  it('parses the BIS CSV and lists the steps', () => {
    const csv = 'FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE\nD,US,2026-09-16,3.625\nD,US,2026-09-17,3.875\nD,US,2026-09-18,3.875\nD,XM,2026-09-18,2.5\nD,XM,2026-09-19,\n';
    const got = parsePolicyCsv(csv);
    expect(got.get('US')).toHaveLength(3);
    expect(got.get('XM')).toEqual([['2026-09-18', 2.5]]);
    expect(rateChanges(got.get('US') ?? [])).toEqual([{ date: '2026-09-17', from: 3.625, to: 3.875 }]);
    expect(rateChanges(got.get('XM') ?? [])).toEqual([]);
  });

  it('reads the comparison list', () => {
    expect(parseHorizons('1m, 2y')).toEqual(['1M', '2Y']);
    expect(parseHorizons('5Y 3M')).toEqual(['3M', '5Y']);
    expect(parseHorizons('')).toEqual(['1M', '1Y']);
    expect(parseHorizons('bogus')).toEqual(['1M', '1Y']);
  });
});

describe('U.S. rates helpers', () => {
  it('subtracts series on shared dates', () => {
    const a: [string, number][] = [['2026-11-20', 4.92], ['2026-11-23', 4.92]];
    const b: [string, number][] = [['2026-11-23', 4.63]];
    expect(spreadSeries(a, b, 100)).toEqual([['2026-11-23', 29]]);
    expect(spreadSeries(a, b)).toEqual([['2026-11-23', 0.29]]);
  });

  it('groups bill columns by maturity', () => {
    const t = parseTreasuryCsv('Date,"4 WEEKS BANK DISCOUNT","4 WEEKS COUPON EQUIVALENT","52 WEEKS BANK DISCOUNT","52 WEEKS COUPON EQUIVALENT"\n11/23/2026,4.04,4.11,4.35,4.55\n');
    const bills = billSeries(t);
    expect(bills.map((b) => b.weeks)).toEqual([4, 52]);
    expect(bills[1].coupon).toEqual([['2026-11-23', 4.55]]);
    expect(bills[0].discount).toEqual([['2026-11-23', 4.04]]);
  });
});

describe('New York Fed', () => {
  it('builds a series per rate type', () => {
    const got = refSeries(
      [
        { effectiveDate: '2026-11-23', type: 'SOFR', percentRate: 3.92 },
        { effectiveDate: '2026-11-20', type: 'SOFR', percentRate: 3.92 },
        { effectiveDate: '2026-11-24', type: 'SOFRAI', average30day: 3.92534 },
      ],
      'percentRate',
    );
    expect(got.get('SOFR')).toEqual([['2026-11-20', 3.92], ['2026-11-23', 3.92]]);
    expect(got.has('SOFRAI')).toBe(false);
  });

  it('lists operations newest first with the award rate', () => {
    const rows = repoRows([
      { operationDate: '2026-11-20', operationType: 'Reverse Repo', term: 'Overnight', termCalenderDays: 3, totalAmtAccepted: 401_000_000, details: [{ percentOfferingRate: 3.75, percentAwardRate: 3.75 }] },
      { operationDate: '2026-11-24', operationType: 'Repo', term: 'Overnight', termCalenderDays: 1, totalAmtAccepted: 1_000_000, details: [{ percentOfferingRate: 4 }] },
    ]);
    expect(rows.map((r) => r.date)).toEqual(['2026-11-24', '2026-11-20']);
    expect(rows[0].rate).toBe(4);
    expect(rows[1]).toMatchObject({ type: 'Reverse Repo', term: 'Overnight (3d)', accepted: 401_000_000, rate: 3.75 });
  });
});

const ois: SdrTrade = {
  actionType: 'NEWT',
  eventType: 'TRAD',
  executionTimestamp: '2026-11-24T14:08:00Z',
  effectiveDate: '2026-11-27',
  expirationDate: '2031-11-27',
  notionalAmountLeg1: '88,000,000',
  notionalCurrencyLeg1: 'USD',
  fixedRateLeg1: '0.04402',
  cleared: 'I',
  platformIdentifier: 'TWSF',
  uniqueProductIdentifierShortName: 'NA/Swap OIS USD',
};

describe('swap repository prints', () => {
  it('keeps new swap executions and converts the rate to percent', () => {
    const prints = swapPrints([
      ois,
      { ...ois, actionType: 'MODI' },
      { ...ois, uniqueProductIdentifierShortName: 'NA/O Opt Epn OIS USD' },
      { ...ois, uniqueProductIdentifierShortName: 'NA/Swap Infl Idx EUR' },
      { ...ois, fixedRateLeg1: null, fixedRateLeg2: null },
      { ...ois, executionTimestamp: '2026-11-24T14:09:00Z', effectiveDate: '2031-11-28', expirationDate: '2036-11-28', notionalAmountLeg1: '250,000,000+', fixedRateLeg1: null, fixedRateLeg2: '0.04596' },
    ]);
    expect(prints).toHaveLength(2);
    expect(prints[0]).toMatchObject({ rate: 4.596, capped: true, notional: 250_000_000, spotStart: false, tenorYears: 5 });
    expect(prints[1]).toMatchObject({ product: 'Swap OIS USD', currency: 'USD', rate: 4.402, tenorYears: 5, cleared: 'To clear', venue: 'TWSF', spotStart: true, capped: false });
  });

  it('summarises spot-starting trades by tenor', () => {
    const prints = swapPrints([ois, { ...ois, fixedRateLeg1: '0.04410' }, { ...ois, effectiveDate: '2031-11-28', expirationDate: '2036-11-28' }]);
    const rows = swapTenorSummary(prints);
    expect(rows).toEqual([{ product: 'Swap OIS USD', tenor: 5, trades: 2, rate: 4.406, low: 4.402, high: 4.41 }]);
  });
});

describe('CDS index levels', () => {
  const cds = (under: string, spread: string, notation: string, extra: Partial<SdrTrade> = {}): SdrTrade => ({
    actionType: 'NEWT',
    eventType: 'TRAD',
    executionTimestamp: '2026-11-24T13:43:35Z',
    expirationDate: '2031-12-20',
    fixedRateLeg1: '0.01',
    spreadLeg1: spread,
    spreadNotationLeg1: notation,
    uniqueProductIdentifierShortName: 'NA/CDS Corp Idx',
    uniqueProductIdentifierUnderlierName: under,
    ...extra,
  });

  it('scales quotes by their notation', () => {
    expect(quoteScale('3', false)).toBe(10_000);
    expect(quoteScale('4', false)).toBe(1);
    expect(quoteScale('2', false)).toBe(100);
    expect(quoteScale('1', true)).toBe(1);
    expect(quoteScale('2', true)).toBe(1);
  });

  it('takes the busiest 5-year maturity per index and labels the quote convention', () => {
    const rows = cdsIndexLevels(
      [
        cds('CDX.NA.IG', '0.006392', '3'),
        cds('CDX.NA.IG', '0.006401', '3', { executionTimestamp: '2026-11-24T13:50:00Z' }),
        cds('CDX.NA.IG', '0.0054', '3', { expirationDate: '2030-12-20' }),
        cds('CDX.NA.IG', '0.0099', '3', { expirationDate: '2036-12-20' }),
        cds('CDX.NA.HY', '0.010466', '3', { fixedRateLeg1: '0.05' }),
        cds('CDX.NA.HY', '104.70', '1', { fixedRateLeg1: '0.05', executionTimestamp: '2026-11-24T13:55:00Z' }),
        cds('ITRAXX EUROPE CROSSOVER', '0.0318704', '3', { fixedRateLeg1: '0.05' }),
        cds('ITRAXX EUROPE SUB FINANCIALS', '0.0118', '3'),
        cds('ITRAXX EUROPE', '0.0064', '3', { actionType: 'TERM' }),
        cds('ITRAXX EUROPE', '', '3'),
      ],
      '2026-11-24',
    );
    expect(rows.map((r) => r.index)).toEqual(['CDX North America IG', 'CDX North America HY', 'iTraxx Europe Crossover']);
    expect(rows[0]).toMatchObject({ quotedAs: 'spread', last: 64.01, low: 63.92, high: 64.01, trades: 2, coupon: 100, maturity: '2031-12-20' });
    expect(rows[1]).toMatchObject({ quotedAs: 'price', last: 104.7, low: 104.66, trades: 2, coupon: 500 });
    expect(rows[2].last).toBe(318.7);
  });
});

describe('credit helpers', () => {
  it('summarises a spread series in basis points', () => {
    const t0 = Date.UTC(2026, 10, 20);
    const pts: [number, number][] = [
      [t0 - 400 * DAY, 4.0],
      [t0 - 31 * DAY, 3.2],
      [t0 - 8 * DAY, 3.1],
      [t0, 3.03],
    ];
    expect(spreadStats(pts)).toMatchObject({ asOf: t0, level: 303, d1w: -7, d1m: -17, d1y: -97, pctile: 25, low: 303, high: 400 });
    expect(spreadStats([])).toBeNull();
  });

  it('picks the fact from the newest annual report', () => {
    const fact = latestAnnualFact([
      { end: '2024-12-31', val: 1, form: '10-K', filed: '2025-02-10' },
      { end: '2025-12-31', val: 2, form: '10-K', filed: '2026-02-09' },
      { end: '2025-12-31', val: 3, form: '10-K/A', filed: '2026-03-01' },
      { end: '2026-06-30', val: 9, form: '10-Q', filed: '2026-07-30' },
    ]);
    expect(fact?.val).toBe(3);
    expect(latestAnnualFact([{ end: '2026-06-30', val: 9, form: '10-Q' }])).toBeNull();
  });
});

describe('FOMC pages', () => {
  it('extracts document links from the calendar', () => {
    const html = `
      <a href="/newsevents/pressreleases/monetary20261028a.htm">HTML</a>
      <a href="/newsevents/pressreleases/monetary20261028a1.htm">Implementation Note</a>
      <a href="/monetarypolicy/fomcminutes20260916.htm">HTML</a>
      <a href="/monetarypolicy/fomcprojtabl20260916.htm">HTML</a>
      <a href="/monetarypolicy/fomcpresconf20261028.htm">Press Conference</a>
      <a href="/newsevents/pressreleases/monetary20261028a.htm">again</a>
      <a href="/aboutthefed.htm">About</a>`;
    const docs = parseFomcCalendar(html);
    expect(docs.map((d) => `${d.date} ${d.kind}`)).toEqual([
      '2026-10-28 Implementation note',
      '2026-10-28 Press conference',
      '2026-10-28 Statement',
      '2026-09-16 Economic projections',
      '2026-09-16 Minutes',
    ]);
    expect(docs[2].url).toBe('https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm');
  });

  it('reads the paragraphs of a press release', () => {
    const html = `<html><body><p>Site navigation text that is long enough to be a paragraph but sits before the article.</p>
      <div id="article"><div class="heading"><p class="article__time">October 28, 2026</p>
      <h3 class="title">Federal Reserve issues FOMC statement</h3><p class="releaseTime">For release at 2:00 p.m. EDT</p></div>
      <div class="col-xs-12 col-sm-8 col-md-8"><p>Economic activity is expanding at a strong pace, and the Committee&rsquo;s goals are unchanged.</p>
      <p>Inflation remains <em>elevated</em>.&nbsp;The Committee will deliver price stability over time.</p>
      <p>For media inquiries, e-mail media@frb.gov or call 202-452-2955.</p><p>This later paragraph must not appear in the extracted statement text at all.</p></div></div></body></html>`;
    const page = parsePressRelease(html);
    expect(page.title).toBe('Federal Reserve issues FOMC statement');
    expect(page.date).toBe('October 28, 2026');
    expect(page.paragraphs).toEqual([
      'Economic activity is expanding at a strong pace, and the Committee’s goals are unchanged.',
      'Inflation remains elevated. The Committee will deliver price stability over time.',
    ]);
  });

  it('reads the press release feed', () => {
    const xml = `<rss><channel><title>FRB</title><item><title>Minutes of the Federal Open Market Committee, October 27-28, 2026</title>
      <link><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20261118a.htm]]></link>
      <pubDate><![CDATA[Wed, 18 Nov 2026 19:00:00 GMT]]></pubDate></item></channel></rss>`;
    expect(parseFedRss(xml)).toEqual([
      { date: '2026-11-18', title: 'Minutes of the Federal Open Market Committee, October 27-28, 2026', url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261118a.htm' },
    ]);
  });

  it('decodes entities and strips tags', () => {
    expect(htmlText('<b>3&ndash;3/4</b> to&nbsp;4 &amp; &#8217;x&#x2019;')).toBe('3–3/4 to 4 & ’x’');
  });
});

describe('government finance helpers', () => {
  it('picks the stop-out rate that applies to the security', () => {
    expect(auctionRate({ high_yield: '4.105', high_investment_rate: 'null', high_discnt_margin: 'null' })).toEqual({ rate: 4.105, kind: 'yield' });
    expect(auctionRate({ high_yield: 'null', high_investment_rate: '4.280', high_discnt_margin: 'null' })).toEqual({ rate: 4.28, kind: 'investment rate' });
    expect(auctionRate({ high_yield: 'null', high_investment_rate: 'null', high_discnt_margin: '0.160' })).toEqual({ rate: 0.16, kind: 'discount margin' });
    expect(auctionRate({ high_yield: 'null', high_investment_rate: 'null', high_discnt_margin: 'null' }).rate).toBeNull();
  });

  it('converts dealer series to dollars and skips suppressed values', () => {
    const pts = pdSeries(
      [
        { asofdate: '2013-04-03', keyid: 'PDFTD-USTET', value: '43736' },
        { asofdate: '2026-11-04', keyid: 'PDFTD-USTET', value: '*' },
        { asofdate: '2026-11-11', keyid: 'PDFTD-USTET', value: '25531' },
      ],
      '2020-01-01',
    );
    expect(pts).toEqual([[Date.UTC(2026, 10, 11), 25_531_000_000]]);
  });
});

describe('bank lookup helpers', () => {
  it('normalises FDIC dates', () => {
    expect(fdicDate('7/17/2026')).toBe('2026-07-17');
    expect(fdicDate('12/1/2009')).toBe('2009-12-01');
  });

  it('assigns asset-size peer groups', () => {
    expect(peerGroup(72_947).label).toBe('under $100M');
    expect(peerGroup(100_000).label).toBe('$100M to $1B');
    expect(peerGroup(4_091_315_000).label).toBe('over $250B');
  });

  it('ranks a bank against its peers', () => {
    const rows = peerTable({ ROA: 1.5, ROE: 18, NIMY: null }, [{ ROA: 0.5, ROE: 5 }, { ROA: 1.0, ROE: 12 }, { ROA: 1.5, ROE: 18 }, { ROA: 2.0, ROE: null }]);
    const roa = rows.find((r) => r.ratio === 'Return on assets');
    expect(roa).toMatchObject({ bank: 1.5, median: 1.25, pctile: 75, peers: 4 });
    const roe = rows.find((r) => r.ratio === 'Return on equity');
    expect(roe).toMatchObject({ bank: 18, median: 12, pctile: 100, peers: 3 });
    expect(rows.find((r) => r.ratio === 'Net interest margin')).toMatchObject({ bank: null, pctile: null, peers: 0 });
  });
});
