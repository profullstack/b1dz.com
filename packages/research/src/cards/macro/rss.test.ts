import { describe, expect, it } from 'vitest';
import { decodeEntities, parseFeed, parseFeedDate, plainText } from './rss.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example &amp; Co Wire</title>
    <link>https://example.test/</link>
    <item>
      <title><![CDATA[Rates held: "no hurry" says chair]]></title>
      <link>https://example.test/a?x=1&amp;y=2</link>
      <description><![CDATA[<p>The committee <b>held</b> rates.<br>More soon.</p>]]></description>
      <guid isPermaLink="false">a-1</guid>
      <pubDate>Wed, 18 Nov 2026 09:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Output rose 1.2% &#8212; fastest since 2021</title>
      <link>https://example.test/b</link>
      <description>&lt;p&gt;Escaped &amp;amp; nested&lt;/p&gt;</description>
      <dc:date>2026-11-17T08:00:00Z</dc:date>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Filings</title>
  <link rel="self" href="https://example.test/feed"/>
  <entry>
    <title type="html">8-K &amp;mdash; Current report</title>
    <link rel="self" href="https://example.test/self"/>
    <link rel="alternate" type="text/html" href="https://example.test/filing/1"/>
    <id>urn:tag:1</id>
    <updated>2026-11-20T16:05:00-05:00</updated>
    <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-11-20</summary>
  </entry>
  <entry>
    <title>No date entry</title>
    <link href='https://example.test/filing/2'/>
    <id>urn:tag:2</id>
  </entry>
</feed>`;

describe('decodeEntities', () => {
  it('decodes named, decimal and hex references', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#x27; &#8364;')).toBe(`a & b <c> "d" 'e' €`);
  });
  it('leaves unknown names and bad code points alone', () => {
    expect(decodeEntities('&bogus; &#0; &#x110000;')).toBe('&bogus; &#0; &#x110000;');
  });
});

describe('plainText', () => {
  it('unwraps CDATA, strips markup and collapses whitespace', () => {
    expect(plainText('<![CDATA[<p>One<br>two</p>]]>\n  three')).toBe('One two three');
  });
  it('handles markup that was entity-escaped', () => {
    expect(plainText('&lt;p&gt;Escaped &amp;amp; nested&lt;/p&gt;')).toBe('Escaped & nested');
  });
});

describe('parseFeedDate', () => {
  it('reads RFC 822 and ISO 8601', () => {
    expect(parseFeedDate('Wed, 18 Nov 2026 09:30:00 GMT')).toBe(Date.UTC(2026, 10, 18, 9, 30));
    expect(parseFeedDate('2026-11-20T16:05:00-05:00')).toBe(Date.UTC(2026, 10, 20, 21, 5));
  });
  it('returns null for nothing usable', () => {
    expect(parseFeedDate(undefined)).toBeNull();
    expect(parseFeedDate('soon')).toBeNull();
  });
});

describe('parseFeed', () => {
  it('reads RSS items with CDATA and entities', () => {
    const f = parseFeed(RSS);
    expect(f.title).toBe('Example & Co Wire');
    expect(f.items).toHaveLength(2);
    expect(f.items[0]).toEqual({
      title: 'Rates held: "no hurry" says chair',
      link: 'https://example.test/a?x=1&y=2',
      date: Date.UTC(2026, 10, 18, 9, 30),
      summary: 'The committee held rates. More soon.',
      id: 'a-1',
    });
    expect(f.items[1].title).toBe('Output rose 1.2% — fastest since 2021');
    expect(f.items[1].date).toBe(Date.UTC(2026, 10, 17, 8));
    expect(f.items[1].summary).toBe('Escaped & nested');
    expect(f.items[1].id).toBe('https://example.test/b');
  });

  it('reads Atom entries and prefers the alternate link', () => {
    const f = parseFeed(ATOM);
    expect(f.title).toBe('Filings');
    expect(f.items).toHaveLength(2);
    expect(f.items[0].link).toBe('https://example.test/filing/1');
    expect(f.items[0].title).toBe('8-K - Current report');
    expect(f.items[0].summary).toBe('Filed: 2026-11-20');
    expect(f.items[0].date).toBe(Date.UTC(2026, 10, 20, 21, 5));
    expect(f.items[1]).toMatchObject({ link: 'https://example.test/filing/2', date: null, id: 'urn:tag:2' });
  });

  it('returns no items for a document that is not a feed', () => {
    expect(parseFeed('<html><body>Access denied</body></html>').items).toEqual([]);
  });
});
