import { describe, expect, it } from 'vitest';
import { billLabel, billRows, billUrl, clockMinutes, congressOf, lastCompleteFiscalYear, memberRows, parseSenateSchedule, sessionOf, voteRows } from './government.js';
import { describe8kItems, parseNasdaqNews, splitPublisher } from './news.js';
import { isTransient } from './portwatch.js';
import { foldPartners } from './trade.js';
import { parseGdpNow, parseMonYy, parseNowcastQuarter, parsePmms, parseSurvey } from './us-activity.js';

describe('parseGdpNow', () => {
  const xml = `<rss version="2.0"><channel><title>feed</title>
    <item><title>Latest Fourth-Quarter GDP Growth Estimate 3.2 Percent</title><pubDate>Wed, 18 Nov 2026 09:30:00 EST</pubDate>
      <description>The GDPNow model estimate for real GDP growth (seasonally adjusted annual rate) in the fourth quarter of 2026 is 3.2 percent on November 18, down from 3.4 percent on November 17.</description></item>
    <item><title>Earlier</title><pubDate>Tue, 27 Oct 2026 10:00:00 EDT</pubDate>
      <description>The GDPNow model estimate for real GDP growth (seasonally adjusted annual rate) in the third quarter of 2026 is -0.5 percent on October 27.</description></item>
    <item><title>Notice</title><pubDate>Mon, 26 Oct 2026 10:00:00 EDT</pubDate><description>The site will be down for maintenance.</description></item>
  </channel></rss>`;
  it('extracts the quarter and estimate from each update, oldest first', () => {
    expect(parseGdpNow(xml)).toEqual([
      { t: Date.UTC(2026, 9, 27, 14), quarter: '2026 Q3', estimate: -0.5 },
      { t: Date.UTC(2026, 10, 18, 14, 30), quarter: '2026 Q4', estimate: 3.2 },
    ]);
  });
  it('returns nothing for a feed without estimates', () => {
    expect(parseGdpNow('<rss><channel></channel></rss>')).toEqual([]);
  });
});

describe('parseNowcastQuarter', () => {
  const chart = {
    chart: { subcaption: '2026:Q4' },
    categories: [{ category: [{ label: '12/30' }, { label: 'CPI Dec', vline: 'true' }, { label: '12/31' }, { label: '01/04' }] }],
    dataset: [
      { seriesname: 'CPI Inflation', data: [{ value: '4.1' }, { value: '4.2' }, { value: '4.3' }] },
      { seriesname: 'Core PCE Inflation', data: [{ value: '3.0' }, { value: '' }, { value: '3.1' }] },
      { seriesname: 'Empty', data: [] },
    ],
  };
  it('skips marker categories and rolls the year over after December', () => {
    const q = parseNowcastQuarter(chart);
    expect(q?.quarter).toBe('2026:Q4');
    expect(q?.series).toEqual([
      { name: 'CPI', points: [[Date.UTC(2026, 11, 30), 4.1], [Date.UTC(2026, 11, 31), 4.2], [Date.UTC(2027, 0, 4), 4.3]] },
      { name: 'Core PCE', points: [[Date.UTC(2026, 11, 30), 3.0], [Date.UTC(2027, 0, 4), 3.1]] },
    ]);
  });
  it('is null without a quarter caption', () => {
    expect(parseNowcastQuarter({ chart: { subcaption: 'n/a' } })).toBeNull();
  });
});

describe('parsePmms', () => {
  it('reads M/D/YYYY dates and leaves gaps out', () => {
    const csv = 'date,pmms30,pmms30p,pmms15,pmms15p\n4/2/1971,7.33, ,,\n11/12/2026,7.11,,6.45,\n11/19/2026,7.28,,6.66,\n';
    const r = parsePmms(csv);
    expect(r.fixed30).toEqual([[Date.UTC(1971, 3, 2), 7.33], [Date.UTC(2026, 10, 12), 7.11], [Date.UTC(2026, 10, 19), 7.28]]);
    expect(r.fixed15).toEqual([[Date.UTC(2026, 10, 12), 6.45], [Date.UTC(2026, 10, 19), 6.66]]);
  });
});

describe('regional Fed surveys', () => {
  it('reads Mon-YY months across the century pivot', () => {
    expect(parseMonYy('Nov-26')).toBe(Date.UTC(2026, 10, 1));
    expect(parseMonYy('May-68')).toBe(Date.UTC(1968, 4, 1));
    expect(parseMonYy('2026-11')).toBeNull();
    expect(parseMonYy('Foo-26')).toBeNull();
  });
  it('reads diffusion indexes with and without a column suffix', () => {
    const philly = 'DATE,GAC,NOC,SHC,NEC,PPC,PRC,GAF\nOct-26,20.9,4.3,15.3,9.1,43.2,40.1,33.0\nNov-26,6.3,-0.4,25.7,11.6,58.2,47.0,33.6\n';
    const rows = parseSurvey(philly, { date: (r) => parseMonYy(r.DATE ?? ''), suffix: '' });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ t: Date.UTC(2026, 10, 1), values: { activity: 6.3, orders: -0.4, shipments: 25.7, employment: 11.6, paid: 58.2, received: 47.0, outlook: 33.6 } });
    const empire = 'surveyDate,GACDISA,NOCDISA,SHCDISA,NECDISA,PPCDISA,PRCDISA,GAFDISA\n2026-11-30,7.8,3.0,8.8,18.1,45.9,27.2,28.9\n2001-07-31,ND,1,1,1,1,1,1\n';
    const e = parseSurvey(empire, { date: (r) => (r.surveyDate ? Date.UTC(Number(r.surveyDate.slice(0, 4)), Number(r.surveyDate.slice(5, 7)) - 1, 1) : null), suffix: 'DISA' });
    expect(e).toEqual([{ t: Date.UTC(2026, 10, 1), values: { activity: 7.8, orders: 3.0, shipments: 8.8, employment: 18.1, paid: 45.9, received: 27.2, outlook: 28.9 } }]);
  });
});

describe('Congress helpers', () => {
  it('numbers Congresses and sessions from the year', () => {
    expect(congressOf(2025)).toBe(119);
    expect(congressOf(2026)).toBe(119);
    expect(congressOf(2027)).toBe(120);
    expect(sessionOf(119, 2025)).toBe(1);
    expect(sessionOf(119, 2026)).toBe(2);
    expect(sessionOf(119, 2030)).toBe(2);
  });
  it('labels and links bills', () => {
    expect(billLabel('HR', '7730')).toBe('H.R. 7730');
    expect(billLabel('sjres', '4')).toBe('S.J.Res. 4');
    expect(billUrl(119, 'HR', '7730')).toBe('https://www.congress.gov/bill/119th-congress/house-bill/7730');
    expect(billUrl(119, 'XX', '1')).toBe('https://www.congress.gov/');
  });
  it('maps bills to rows', () => {
    const rows = billRows([{ congress: 119, type: 'HR', number: '7730', title: 'A Bill', updateDate: '2026-11-18', latestAction: { actionDate: '2026-11-10', text: 'Became Public Law No: 119-142.' }, laws: [{ number: '119-142', type: 'Public Law' }] }]);
    expect(rows[0]).toMatchObject({ bill: 'H.R. 7730', title: 'A Bill', actionDate: '2026-11-10', action: 'Became Public Law No: 119-142.', law: '119-142' });
  });
  it('sorts votes newest first whatever order the API uses', () => {
    const rows = voteRows([
      { rollCallNumber: 240, startDate: '2025-09-08T18:56:00-04:00', result: 'Passed', legislationType: 'HR', legislationNumber: '3424', voteType: 'Yea-And-Nay' },
      { rollCallNumber: 306, startDate: '2025-12-01T18:57:00-05:00', result: 'Failed', voteType: 'Recorded Vote' },
      { rollCallNumber: 1 },
    ]);
    expect(rows.map((r) => r.roll)).toEqual([306, 240]);
    expect(rows[1]).toMatchObject({ date: '2025-09-08', measure: 'H.R. 3424', result: 'Passed' });
    expect(rows[0].measure).toBe('');
  });
  it('lists senators first, then representatives by district', () => {
    const rows = memberRows([
      { name: 'Rep, Two', partyName: 'Republican', district: 2, bioguideId: 'R2', terms: { item: [{ chamber: 'House of Representatives', startYear: 2019 }] } },
      { name: 'Sen, B', partyName: 'Democratic', bioguideId: 'S1', terms: { item: [{ chamber: 'House of Representatives', startYear: 2001, endYear: 2024 }, { chamber: 'Senate', startYear: 2024 }] } },
      { name: 'Rep, AtLarge', partyName: 'Democratic', terms: { item: [{ chamber: 'House of Representatives', startYear: 2023 }] } },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Sen, B', 'Rep, AtLarge', 'Rep, Two']);
    expect(rows[0]).toMatchObject({ chamber: 'Senate', district: null, since: '2001', link: 'https://www.congress.gov/member/S1' });
    expect(rows[1]).toMatchObject({ chamber: 'House', district: 'At large', link: '' });
  });
});

describe('parseSenateSchedule', () => {
  const xml = `<?xml version="1.0"?><css_meetings_scheduled>
    <meeting><cmte_code/><committee/><date_iso_8601>2026-11-24</date_iso_8601><time>08:00:00</time><matter>No committee hearings scheduled</matter></meeting>
    <meeting><committee>Banking, Housing, and Urban Affairs</committee><type>Open Hearing</type><date_iso_8601>2026-12-03</date_iso_8601><time>10:00 AM</time><room>SD-106</room><matter>Oversight hearings to examine export controls &amp; licensing.</matter></meeting>
    <meeting><committee>Intelligence</committee><type>Closed Hearing</type><date_iso_8601>2026-12-01</date_iso_8601><time>03:00 PM</time><room>SH-219</room><matter/>
      <Documents><AssociatedDocument congress="119" document_description="A nomination, of Texas. " document_num="1"/></Documents></meeting>
    <meeting><committee>Commerce</committee><sub_cmte>Aviation</sub_cmte><type>Open Hearing</type><date_iso_8601>2026-12-01</date_iso_8601><time>10:00 AM</time><room>SR-253</room><matter>Air traffic.</matter></meeting>
  </css_meetings_scheduled>`;
  it('skips the placeholder, sorts by date then clock time, and falls back to document text', () => {
    const h = parseSenateSchedule(xml);
    expect(h.map((x) => `${x.date} ${x.time} ${x.committee}`)).toEqual([
      '2026-12-01 10:00 AM Commerce: Aviation',
      '2026-12-01 03:00 PM Intelligence',
      '2026-12-03 10:00 AM Banking, Housing, and Urban Affairs',
    ]);
    expect(h[1].matter).toBe('A nomination, of Texas.');
    expect(h[2].matter).toBe('Oversight hearings to examine export controls & licensing.');
  });
  it('orders clock times', () => {
    expect(clockMinutes('12:15 AM')).toBe(15);
    expect(clockMinutes('12:15 PM')).toBe(735);
    expect(clockMinutes('14:30:00')).toBe(870);
    expect(clockMinutes('TBA')).toBe(1440);
  });
});

describe('spending and trade helpers', () => {
  it('finds the latest completed fiscal year', () => {
    expect(lastCompleteFiscalYear(new Date(Date.UTC(2026, 10, 24)))).toBe(2026);
    expect(lastCompleteFiscalYear(new Date(Date.UTC(2026, 8, 30)))).toBe(2025);
    expect(lastCompleteFiscalYear(new Date(Date.UTC(2026, 9, 1)))).toBe(2026);
  });
  it('folds Comtrade flows into partners, largest total trade first, with the world separate', () => {
    const r = foldPartners([
      { partnerCode: 0, flowCode: 'M', primaryValue: 1000 },
      { partnerCode: 0, flowCode: 'X', primaryValue: 700 },
      { partnerCode: 124, flowCode: 'M', primaryValue: 300 },
      { partnerCode: 124, flowCode: 'X', primaryValue: 250 },
      { partnerCode: 156, flowCode: 'M', primaryValue: 400 },
      { partnerCode: 484, flowCode: 'X', primaryValue: 600 },
      { partnerCode: 484, flowCode: 'RX', primaryValue: 50 },
      { partnerCode: 392, flowCode: 'M', primaryValue: null },
    ]);
    expect(r.world).toEqual({ code: 0, imports: 1000, exports: 700 });
    expect(r.partners).toEqual([
      { code: 484, imports: 0, exports: 600 },
      { code: 124, imports: 300, exports: 250 },
      { code: 156, imports: 400, exports: 0 },
    ]);
  });
  it('retries only the error bodies a healthy PortWatch query can return', () => {
    expect(isTransient({ code: 400, message: 'Invalid URL' })).toBe(true);
    expect(isTransient({ code: 400, message: 'Cannot perform query. Invalid query parameters.' })).toBe(true);
    expect(isTransient({ code: 499, message: 'Token Required' })).toBe(false);
    expect(isTransient({ code: 400, message: "'bogus' is not a valid field" })).toBe(false);
  });
});

describe('news helpers', () => {
  it('reads Nasdaq symbol news rows', () => {
    const rows = parseNasdaqNews({ data: { rows: [{ title: ' Chip stocks slide ', created: 'Nov 24, 2026', ago: '1 hour ago', publisher: 'Example Wire', url: '/articles/chip-stocks-slide' }, { created: 'Nov 23, 2026' }] } });
    expect(rows).toEqual([{ date: '2026-11-24', age: '1 hour ago', title: 'Chip stocks slide', source: 'Example Wire', link: 'https://www.nasdaq.com/articles/chip-stocks-slide' }]);
    expect(parseNasdaqNews({ data: null })).toEqual([]);
  });
  it('names the items of a Form 8-K', () => {
    expect(describe8kItems('2.02,9.01')).toBe('Results of operations; Exhibits');
    expect(describe8kItems('5.02, 6.66')).toBe('Director or officer change; Item 6.66');
    expect(describe8kItems('')).toBe('');
  });
  it('splits a trailing publisher from an aggregator title', () => {
    expect(splitPublisher('German business morale rises again - Example Daily')).toEqual({ title: 'German business morale rises again', publisher: 'Example Daily' });
    expect(splitPublisher('No publisher here')).toEqual({ title: 'No publisher here', publisher: null });
  });
});
