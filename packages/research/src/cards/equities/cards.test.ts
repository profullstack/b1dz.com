import { describe, expect, it } from 'vitest';
import type { Bar } from '../../lib/market.js';
import { holdingKey, pickBank } from './company-bank.js';
import { monthKey, surpriseRows } from './company-estimates.js';
import { changeView, commonSize, dupontRows, roicRows, type Financials } from './company-financials.js';
import { declaredDividends, dividendsByYear, extractSection, parseFinraShort } from './company-ownership.js';
import { compRow, medianRow } from './company-peers.js';
import { overlap, parseBrowseAtom, parseNport, weightBy, type Holding } from './etfs.js';
import { correlationMatrix, rotation } from './factors.js';
import { equities } from './index.js';
import { cagr, drawdownSeries } from './indices.js';
import { calendarDate } from './screeners.js';
import { looksLikeCusip, parseDisplayName, rankTickers } from './search.js';
import { parseAdvHits, parseFts } from './sec-research.js';
import { issuerKey, parseListings, pickPeers } from './universe.js';
import type { ValueTable } from './util.js';

const table = (periods: string[], rows: Record<string, (number | null)[]>): ValueTable => ({ periods, rows: Object.entries(rows).map(([label, values]) => ({ label, values, heading: false })) });

const fin: Financials = {
  income: table(['2026', '2025'], {
    'Total Revenue': [1000, 800],
    'Cost of Revenue': [600, 500],
    'Gross Profit': [400, 300],
    'Operating Income': [200, 120],
    'Earnings Before Tax': [200, 100],
    'Income Tax': [50, 20],
    'Net Income': [150, 80],
  }),
  balance: table(['2026', '2025'], {
    'Cash and Cash Equivalents': [100, 50],
    'Short-Term Investments': [0, null],
    'Total Current Assets': [300, 250],
    'Total Assets': [2000, 1600],
    'Short-Term Debt / Current Portion of Long-Term Debt': [50, 50],
    'Long-Term Debt': [250, 200],
    'Total Equity': [500, 400],
  }),
  cash: table(['2026', '2025'], {}),
  ratios: table(['2026', '2025'], {}),
};

describe('statement views and ratios', () => {
  it('common size and change views', () => {
    const cs = commonSize(fin.income, [1000, 800]);
    expect(cs.rows[1].values).toEqual([60, 62.5]);
    const ch = changeView(fin.income);
    expect(ch.rows[0].values).toEqual([25, null]);
  });
  it('ROIC uses the effective tax rate and average invested capital', () => {
    const [now, prior] = roicRows(fin);
    expect(now.taxRate).toBe(25);
    expect(now.nopat).toBe(150);
    // Invested capital: 500+50+250-100 = 700 now, 400+50+200-50 = 600 before; average 650.
    expect(now.invested).toBe(650);
    expect(now.roic).toBeCloseTo((150 / 650) * 100);
    expect(prior.invested).toBe(600);
    expect(prior.roic).toBeCloseTo(((120 * 0.8) / 600) * 100);
  });
  it('DuPont factors multiply to ROE', () => {
    const [d] = dupontRows(fin);
    expect(d.margin).toBe(15);
    expect(d.turnover).toBe(0.5);
    expect(d.leverage).toBe(4);
    expect(d.roe).toBe(30);
    expect(d.roe).toBeCloseTo((150 / 500) * 100);
  });
  it('comparable-company multiples and the peer median', () => {
    const c = compRow('X', 3000, fin);
    expect(c.ev).toBe(3000 + 300 - 100);
    expect(c.pe).toBe(20);
    expect(c.ps).toBe(3);
    expect(c.pb).toBe(6);
    expect(c.evSales).toBeCloseTo(3.2);
    expect(c.grossMargin).toBe(40);
    expect(c.netMargin).toBe(15);
    expect(c.growth).toBe(25);
    expect(c.roe).toBe(30);
    expect(c.debtEquity).toBe(0.6);
    // An unclassified balance sheet (bank, insurer): no enterprise value or debt/equity.
    const bank = compRow('B', 3000, { ...fin, balance: table(['2026'], { 'Total Assets': [2000], 'Long-Term Debt': [250], 'Total Equity': [500] }) });
    expect(bank.ev).toBeNull();
    expect(bank.debtEquity).toBeNull();
    expect(bank.pb).toBe(6);
    const loss = compRow('L', 1000, { ...fin, income: table(['2026'], { 'Total Revenue': [100], 'Net Income': [-5] }) });
    expect(loss.pe).toBeNull();
    expect(medianRow([c, { ...c, pe: 10 }, { ...c, pe: null }]).pe).toBe(15);
  });
});

describe('estimates', () => {
  it('builds the surprise history newest first with year-on-year change', () => {
    const q = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31'].map((end, i) => ({ end, filed: end, val: 1 + i * 0.25 }));
    const rows = surpriseRows(q, new Map([['2026-03', { consensus: 1.9, surprisePct: 5.26 }]]), 3);
    expect(rows.map((r) => r.end)).toEqual(['2026-03-31', '2025-12-31', '2025-09-30']);
    expect(rows[0].yoy).toBeCloseTo(100);
    expect(rows[0].consensus).toBe(1.9);
    expect(rows[1].yoy).toBeNull();
    expect(monthKey('Sep 2026')).toBe('2026-09');
    expect(monthKey('garbage')).toBe('');
  });
});

describe('ownership helpers', () => {
  it('totals dividends by ex-date year', () => {
    expect(dividendsByYear([{ date: '2026-02-09', amount: 0.26 }, { date: '2026-05-11', amount: 0.27 }, { date: '2025-11-10', amount: 0.26 }, { date: '', amount: 1 }, { date: '2025-08-11', amount: null }])).toEqual([
      { year: 2025, total: 0.26, count: 1 },
      { year: 2026, total: 0.53, count: 2 },
    ]);
  });
  it('reads dividends declared per quarter from XBRL, newest first', () => {
    const fact = (start: string, end: string, val: number, filed: string): { start: string; end: string; val: number; filed: string } => ({ start, end, val, filed });
    const rows = declaredDividends({
      facts: {
        'us-gaap': {
          CommonStockDividendsPerShareDeclared: {
            units: {
              'USD/shares': [fact('2025-01-01', '2025-03-31', 1.25, '2025-05-01'), fact('2025-04-01', '2025-06-30', 1.4, '2025-08-01'), fact('2025-07-01', '2025-09-30', 1.5, '2025-11-01'), fact('2025-01-01', '2025-12-31', 5.65, '2026-02-15'), fact('2026-01-01', '2026-03-31', 0, '2026-05-01')],
            },
          },
        },
      },
    });
    expect(rows).toEqual([
      { date: '2025-12-31', amount: 1.5, derived: true },
      { date: '2025-09-30', amount: 1.5, derived: false },
      { date: '2025-06-30', amount: 1.4, derived: false },
      { date: '2025-03-31', amount: 1.25, derived: false },
    ]);
  });
  it('parses the FINRA short interest file', () => {
    const csv = '"accountingYearMonthNumber","symbolCode","issueName","marketClassCode","currentShortPositionQuantity","previousShortPositionQuantity","stockSplitFlag","averageDailyVolumeQuantity","daysToCoverQuantity","revisionFlag","changePercent","changePreviousNumber","settlementDate"\n"20260915","JPM","JPMorgan Chase & Co.","NYSE","23990561","26537949",,"6585318","3.64",,"-9.60","-2547388","2026-09-15"\n"20260930","JPM","JPMorgan Chase & Co.","NYSE","24120442","23990561",,"9395756","2.57",,"0.54","129881","2026-09-30"\n';
    expect(parseFinraShort(csv)).toEqual([
      { date: '2026-09-30', interest: 24120442, adv: 9395756, days: 2.57 },
      { date: '2026-09-15', interest: 23990561, adv: 6585318, days: 3.64 },
    ]);
    expect(parseFinraShort('')).toEqual([]);
  });
  it('extracts the real section, not its table-of-contents line', () => {
    const body = 'We face competition. '.repeat(40);
    const doc = `TABLE OF CONTENTS\nItem 1A. Risk Factors 5\nItem 1B. Unresolved Staff Comments 17\nItem 7. Management's Discussion and Analysis 21\nItem 7A. Quantitative 30\n\nPART I\nItem 1A. Risk Factors\n${body}\nItem 1B. Unresolved Staff Comments\nNone.\nItem 7. Management’s Discussion and Analysis of Financial Condition\nSales rose. ${body}\nItem 7A. Quantitative and Qualitative Disclosures`;
    const risk = extractSection(doc, 'risk-factors');
    expect(risk.startsWith('Item 1A. Risk Factors\nWe face competition.')).toBe(true);
    expect(risk).not.toContain('Unresolved');
    const mda = extractSection(doc, 'mda');
    expect(mda).toContain('Sales rose.');
    expect(mda).not.toContain('Item 7A');
    expect(extractSection('nothing here', 'mda')).toBe('');
  });
});

describe('bank matching', () => {
  it('matches a holding company across SEC and FDIC spellings', () => {
    expect(holdingKey('JPMORGAN CHASE & CO')).toBe(holdingKey('JPMORGAN CHASE&CO'));
    expect(holdingKey('BANK OF AMERICA CORP /DE/')).toBe(holdingKey('BANK OF AMERICA CORPORATION'));
    expect(holdingKey('WELLS FARGO & COMPANY/MN')).toBe('WELLSFARGO');
    expect(holdingKey('U S BANCORP \\DE\\')).toBe(holdingKey('U.S. BANCORP'));
    const list = [
      { NAME: 'Small Bank', CERT: 2, ASSET: 10, NAMEHCR: 'JPMORGAN CHASE&CO' },
      { NAME: 'JPMorgan Chase Bank, National Association', CERT: 628, ASSET: 4000, NAMEHCR: 'JPMORGAN CHASE&CO' },
      { NAME: 'Other', CERT: 3, ASSET: 9000, NAMEHCR: 'USAA CAPITAL CORP' },
      { NAME: 'Apple Bank', CERT: 4, ASSET: 20, NAMEHCR: 'APPLE FINANCIAL HOLDINGS INC' },
    ];
    expect(pickBank(list, 'JPMORGAN CHASE & CO')?.CERT).toBe(628);
    expect(pickBank(list, 'U S BANCORP')).toBeNull();
    expect(pickBank(list, 'Apple Inc.')).toBeNull();
  });
});

describe('peer selection', () => {
  const list = parseListings([
    { symbol: 'AAA', name: 'Alpha Inc. Common Stock', marketCap: '1000', sector: 'Tech', industry: 'Chips', lastsale: '$10', pctchange: '1.5%' },
    { symbol: 'BBB', name: 'Beta Corp Common Stock', marketCap: '900', sector: 'Tech', industry: 'Chips' },
    { symbol: 'BBB/A', name: 'Beta Corp Class A Common Stock', marketCap: '950', sector: 'Tech', industry: 'Chips' },
    { symbol: 'CCC', name: 'Gamma Ltd Ordinary Shares', marketCap: '10', sector: 'Tech', industry: 'Chips' },
    { symbol: 'DDD', name: 'Delta 6% Preferred', marketCap: '1000', sector: 'Tech', industry: 'Chips' },
    { symbol: 'EEE', name: 'Epsilon Inc.', marketCap: '1100', sector: 'Tech', industry: 'Software' },
    { symbol: 'FFF', name: 'Phi Inc.', marketCap: '0.00', sector: 'Tech', industry: 'Chips' },
    { symbol: 'GGG', name: 'Eta Semiconductor Inc.', marketCap: '500', sector: 'Tech', industry: 'Chips' },
  ]);
  it('parses listings', () => {
    expect(list[0]).toMatchObject({ symbol: 'AAA', marketCap: 1000, last: 10, changePct: 1.5 });
    expect(list[2].symbol).toBe('BBB.A');
    expect(list[6].marketCap).toBeNull();
  });
  it('keys issuers without share-class words', () => {
    expect(issuerKey('Beta Corp Class A Common Stock')).toBe(issuerKey('Beta Corp Common Stock'));
    expect(issuerKey('Apple Inc. Common Stock')).toBe(issuerKey('Apple Inc'));
    expect(issuerKey('Alphabet Inc. Class C Capital Stock')).toBe('alphabet');
  });
  it('prefers the same industry, nearest in size, one class per issuer, common equity only', () => {
    expect(pickPeers(list, 'AAA', 6)).toEqual(['BBB.A', 'GGG', 'CCC']);
    // Software has no other member, so the sector is used.
    expect(pickPeers(list, 'EEE', 2)).toEqual(['AAA', 'BBB.A']);
    expect(pickPeers(list, 'ZZZ')).toEqual([]);
  });
});

describe('funds', () => {
  const xml = `<edgarSubmission><formData><genInfo><regName>Example &amp; Co Trust</regName><seriesName>Example 500 ETF</seriesName><repPdEnd>2026-09-30</repPdEnd><repPdDate>2026-06-30</repPdDate></genInfo>
    <fundInfo><totAssets>1000.50</totAssets><netAssets>990.25</netAssets><returnInfo><monthlyTotReturns><monthlyTotReturn rtn1="1.50" rtn2="-2.25" rtn3="N/A"/></monthlyTotReturns></returnInfo></fundInfo>
    <invstOrSecs>
      <invstOrSec><name>Aflac Inc</name><title>Aflac Inc</title><cusip>001055102</cusip><identifiers><isin value="US0010551028"/></identifiers><balance>5.0</balance><units>NS</units><curCd>USD</curCd><valUSD>100.00</valUSD><pctVal>10.1</pctVal><assetCat>EC</assetCat><issuerCat>CORP</issuerCat><invCountry>US</invCountry></invstOrSec>
      <invstOrSec><name>Big Co</name><title>Big Co</title><cusip>999999999</cusip><balance>9</balance><units>NS</units><curCd>USD</curCd><valUSD>300.00</valUSD><pctVal>30.3</pctVal><assetConditional desc="x" assetCat="OTHER"/><issuerCat>CORP</issuerCat><invCountry>IE</invCountry></invstOrSec>
    </invstOrSecs></formData></edgarSubmission>`;
  const p = parseNport(xml);
  it('parses an N-PORT document', () => {
    expect(p.registrant).toBe('Example & Co Trust');
    expect(p.series).toBe('Example 500 ETF');
    expect(p.periodDate).toBe('2026-06-30');
    expect(p.netAssets).toBe(990.25);
    expect(p.monthlyReturns).toEqual([1.5, -2.25, null]);
    expect(p.holdings.map((h) => h.name)).toEqual(['Big Co', 'Aflac Inc']);
    expect(p.holdings[1]).toMatchObject({ cusip: '001055102', isin: 'US0010551028', pct: 10.1, assetCat: 'EC', country: 'US' });
    expect(p.holdings[0].assetCat).toBe('OTHER');
  });
  it('sums weights by key', () => {
    expect(weightBy(p.holdings, (h) => h.country, (h) => h.pct)).toEqual([{ key: 'IE', weight: 30.3, count: 1 }, { key: 'US', weight: 10.1, count: 1 }]);
  });
  it('measures overlap as the sum of the smaller weights', () => {
    const h = (name: string, cusip: string, pct: number | null): Holding => ({ name, title: name, cusip, isin: '', balance: null, units: '', currency: 'USD', valueUsd: null, pct, assetCat: 'EC', issuerCat: '', country: 'US' });
    const o = overlap([h('A', '111111111', 50), h('B', '222222222', 30), h('C', '333333333', 20)], [h('A', '111111111', 10), h('B', '222222222', 60), h('D', '444444444', 30), h('Short', '555555555', -5)]);
    expect(o.weight).toBe(40);
    expect(o.common.map((c) => c.name)).toEqual(['B', 'A']);
    expect(o.countA).toBe(3);
    expect(o.countB).toBe(3);
  });
  it('reads an EDGAR browse feed', () => {
    const atom = '<feed><entry><category term="NPORT-P"/><content type="text/xml"><accession-number>0001752724-26-000001</accession-number><filing-date>2026-08-27</filing-date><filing-href>https://www.sec.gov/Archives/edgar/data/1100663/000175272426000001/0001752724-26-000001-index.htm</filing-href><filing-type>NPORT-P</filing-type></content></entry></feed>';
    expect(parseBrowseAtom(atom)).toEqual([{ accession: '0001752724-26-000001', filed: '2026-08-27', form: 'NPORT-P', href: 'https://www.sec.gov/Archives/edgar/data/1100663/000175272426000001/0001752724-26-000001-index.htm' }]);
  });
});

describe('index and factor maths', () => {
  const bars = (closes: number[], stepDays = 1): Bar[] => closes.map((c, i) => ({ t: i * stepDays * 86_400_000, o: c, h: c, l: c, c, v: null }));
  it('compound growth and drawdown', () => {
    const b = bars([100, 121], 730.5);
    expect(cagr(b[0], b[1])).toBeCloseTo(10);
    expect(drawdownSeries(bars([100, 120, 90, 120, 60])).map(([, v]) => Math.round(v))).toEqual([0, 0, -25, 0, -50]);
  });
  it('correlation matrix is symmetric with a unit diagonal', () => {
    const a = bars([100, 101, 103, 102, 105, 104]);
    const b = bars([50, 50.5, 51.5, 51, 52.5, 52]);
    const c = bars([10, 9.9, 9.7, 9.8, 9.5, 9.6]);
    const m = correlationMatrix([{ symbol: 'A', bars: a }, { symbol: 'B', bars: b }, { symbol: 'C', bars: c }]);
    expect(m[0][0]).toBe(1);
    expect(m[0][1]).toBeCloseTo(1, 3);
    expect(m[0][2]).toBeCloseTo(-1, 2);
    expect(m[1][2]).toBeCloseTo(m[2][1] as number);
  });
  it('relative rotation quadrants', () => {
    const n = 120;
    const bench = bars(Array.from({ length: n }, () => 100));
    // Relative strength rising faster and faster: above its average and still building.
    const leading = bars(Array.from({ length: n }, (_, i) => 100 * 1.0001 ** (i * i)));
    expect(rotation(leading, bench).quadrant).toBe('Leading');
    const lagging = bars(Array.from({ length: n }, (_, i) => 100 * 0.9999 ** (i * i)));
    expect(rotation(lagging, bench).quadrant).toBe('Lagging');
    // A long rise that has started to roll over: still above average, losing momentum.
    const weakening = bars(Array.from({ length: n }, (_, i) => (i < 100 ? 100 + i : 200 - (i - 100) * 0.5)));
    const w = rotation(weakening, bench);
    expect(w.ratio).toBeGreaterThan(100);
    expect(w.momentum).toBeLessThan(100);
    expect(w.quadrant).toBe('Weakening');
    expect(rotation(bars([1, 2, 3]), bench)).toEqual({ ratio: null, momentum: null, quadrant: '' });
    const flat = rotation(bench, bench);
    expect(flat.ratio).toBeCloseTo(100);
    expect(flat.momentum).toBeCloseTo(100);
  });
});

describe('search and SEC parsing', () => {
  const list = [
    { cik: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    { cik: 2, ticker: 'APLE', title: 'Apple Hospitality REIT, Inc.' },
    { cik: 3, ticker: 'AAP', title: 'ADVANCE AUTO PARTS INC' },
    { cik: 4, ticker: 'PINE', title: 'Pineapple Energy Inc.' },
    { cik: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
  ];
  it('ranks an exact ticker first, then prefixes and names', () => {
    expect(rankTickers(list, 'aap').map((t) => t.ticker)).toEqual(['AAP', 'AAPL']);
    expect(rankTickers(list, 'apple').map((t) => t.ticker)).toEqual(['AAPL', 'APLE', 'PINE']);
    expect(rankTickers(list, 'brk.b')[0].cik).toBe(1067983);
    expect(rankTickers(list, '  ')).toEqual([]);
  });
  it('recognises CUSIPs and EDGAR display names', () => {
    expect(looksLikeCusip('037833100')).toBe(true);
    expect(looksLikeCusip('67066G104')).toBe(true);
    expect(looksLikeCusip('MICROSOFT')).toBe(false);
    expect(parseDisplayName('Apple Inc.  (AAPL)  (CIK 0000320193)')).toEqual({ name: 'Apple Inc.', ticker: 'AAPL', cik: 320193 });
    expect(parseDisplayName('BERKSHIRE HATHAWAY INC  (BRK-A, BRK-B)  (CIK 0001067983)')?.ticker).toBe('BRK-A');
    expect(parseDisplayName('Some Private Fund LP  (CIK 0001234567)')).toEqual({ name: 'Some Private Fund LP', ticker: '', cik: 1234567 });
  });
  it('maps full-text search hits to document links', () => {
    const rows = parseFts({ hits: { hits: [{ _id: '0000035527-22-000119:fitb10-k.pdf', _source: { ciks: ['0000035527'], display_names: ['FIFTH THIRD BANCORP  (FITB)  (CIK 0000035527)'], file_date: '2022-02-25', form: '10-K', file_type: 'EX-13', file_description: 'ANNUAL REPORT', adsh: '0000035527-22-000119' } }, { _id: 'broken' }] } });
    expect(rows).toEqual([{ filed: '2022-02-25', form: '10-K', company: 'FIFTH THIRD BANCORP (FITB)', document: 'EX-13 ANNUAL REPORT', period: '', url: 'https://www.sec.gov/Archives/edgar/data/35527/000003552722000119/fitb10-k.pdf' }]);
  });
  it('reads adviser search hits', () => {
    const rows = parseAdvHits([{ _source: { firm_source_id: '105129', firm_name: 'BRIDGEWATER ASSOCIATES, LP', firm_ia_full_sec_number: '801-35875', firm_ia_scope: 'ACTIVE', firm_ia_disclosure_fl: 'N', firm_other_names: ['BRIDGEWATER ASSOCIATES, LP', 'BRIDGEWATER'], firm_ia_address_details: '{"officeAddress": {"city": "WESTPORT", "state": "CT", "country": "United States"}}' } }, { _source: {} }]);
    expect(rows).toEqual([{ firm: 'BRIDGEWATER ASSOCIATES, LP', sec: '801-35875', crd: '105129', status: 'ACTIVE', disclosures: 'No', office: 'WESTPORT, CT', aka: 'BRIDGEWATER', url: 'https://adviserinfo.sec.gov/firm/summary/105129' }]);
  });
  it('resolves calendar dates in New York time', () => {
    expect(calendarDate('2026-11-20', new Date('2026-11-24T12:00:00Z'))).toBe('2026-11-20');
    expect(calendarDate('today', new Date('2026-11-24T02:00:00Z'))).toBe('2026-11-23');
    expect(calendarDate(undefined, new Date('2026-11-24T12:00:00Z'))).toBe('2026-11-24');
  });
});

describe('module wiring', () => {
  it('every dashboard card exists, ids are unique and every card is on a dashboard', () => {
    const ids = equities.cards.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^equities\.[a-z0-9-]+$/.test(id))).toBe(true);
    const used = new Set(equities.dashboards.flatMap((d) => d.tabs.flatMap((t) => t.cards)));
    expect([...used].filter((id) => !ids.includes(id))).toEqual([]);
    expect(ids.filter((id) => !used.has(id))).toEqual([]);
    expect(equities.dashboards.map((d) => d.id)).toEqual(['company', 'screeners', 'calendars', 'canada', 'nordics', 'indices', 'etfs', 'factors', 'sec']);
  });
  it('every param has a default so each card runs with no input', () => {
    for (const c of equities.cards) for (const p of c.params ?? []) expect(p.default === undefined ? `${c.id}.${p.name}` : '').toBe('');
  });
});
