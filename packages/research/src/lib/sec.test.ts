import { describe, expect, it } from 'vitest';
import { cik10, decodeEntities, filingDocUrl, filingIndexUrl, htmlToText, parseFeed, parseFilingIndex, parseSubmissions, parseTickers, secSymbol } from './sec.js';

describe('SEC helpers', () => {
  it('parses the ticker file', () => {
    expect(parseTickers({ 0: { cik_str: 320193, ticker: 'aapl', title: 'Apple Inc.' }, 1: { ticker: 'X' } })).toEqual([{ cik: 320193, ticker: 'AAPL', title: 'Apple Inc.' }]);
  });
  it('normalises symbols and CIKs', () => {
    expect(secSymbol('brk.b')).toBe('BRK-B');
    expect(cik10(320193)).toBe('0000320193');
  });
  it('turns the columnar filings block into rows', () => {
    const s = parseSubmissions({
      name: 'Apple Inc.',
      sic: '3571',
      filings: { recent: { accessionNumber: ['0000320193-26-000024', '0001140361-26-044952'], form: ['8-K', '4'], filingDate: ['2026-11-02', '2026-11-19'], reportDate: ['2026-11-02', '2026-11-17'], primaryDocument: ['a8-k.htm', 'xslF345X06/form4.xml'], primaryDocDescription: ['8-K', 'FORM 4'], items: ['2.02,9.01', ''] } },
    });
    expect(s.filings).toHaveLength(2);
    expect(s.filings[0]).toMatchObject({ form: '8-K', items: '2.02,9.01', filingDate: '2026-11-02' });
    expect(parseSubmissions({}).filings).toEqual([]);
  });
  it('builds document and index URLs', () => {
    expect(filingDocUrl(320193, '0001140361-26-044952', 'xslF345X06/form4.xml')).toBe('https://www.sec.gov/Archives/edgar/data/320193/000114036126044952/form4.xml');
    expect(filingIndexUrl(320193, '0000320193-26-000024')).toBe('https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/0000320193-26-000024-index.htm');
  });
  it('reads the document table of a filing index', () => {
    const html = `<table class="tableFile"><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
      <tr><td>1</td><td>8-K</td><td><a href="/ix?doc=/Archives/edgar/data/320193/000032019326000024/aapl-20261102.htm">aapl-20261102.htm</a> iXBRL</td><td>8-K</td><td>30000</td></tr>
      <tr><td>2</td><td>EX-99.1</td><td><a href="/Archives/edgar/data/320193/000032019326000024/a8-kex991.htm">a8-kex991.htm</a></td><td>EX-99.1</td><td>90000</td></tr></table>`;
    const docs = parseFilingIndex(html);
    expect(docs.map((d) => d.type)).toEqual(['8-K', 'EX-99.1']);
    expect(docs[0].url).toBe('https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/aapl-20261102.htm');
    expect(docs[1].name).toBe('a8-kex991.htm');
  });
  it('converts filing HTML to text', () => {
    expect(decodeEntities('A&amp;B &#8217;s &#x41; &nbsp;x &unknown;')).toBe("A&B 's A  x &unknown;");
    expect(htmlToText('<style>p{}</style><p>Item&nbsp;1A. <b>Risk</b> Factors</p><div>Line two<br>Line three</div><table><tr><td>a</td><td>b</td></tr></table>')).toBe('Item 1A. Risk Factors\nLine two\nLine three\na b');
  });
  it('parses RSS and Atom items', () => {
    const rss = '<rss><channel><item><title> SEC Issues Proposal </title><link>https://www.sec.gov/x</link><pubDate>Mon, 23 Nov 2026 12:00:00 -0500</pubDate><description>&lt;p&gt;Hello &amp;amp; more&lt;/p&gt;</description></item></channel></rss>';
    expect(parseFeed(rss)).toEqual([{ title: 'SEC Issues Proposal', link: 'https://www.sec.gov/x', date: '2026-11-23T17:00:00.000Z', summary: 'Hello & more' }]);
    const atom = '<feed><entry><title>8-K - Acme Corp (0001234567) (Filer)</title><link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1234567/x-index.htm"/><summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-11-23 &lt;b&gt;AccNo:&lt;/b&gt; 0001234567-26-000001</summary><updated>2026-11-23T19:26:42-05:00</updated></entry></feed>';
    const e = parseFeed(atom)[0];
    expect(e.title).toBe('8-K - Acme Corp (0001234567) (Filer)');
    expect(e.link).toBe('https://www.sec.gov/Archives/edgar/data/1234567/x-index.htm');
    expect(e.date).toBe('2026-11-24T00:26:42.000Z');
    expect(e.summary).toContain('AccNo: 0001234567-26-000001');
  });
});
