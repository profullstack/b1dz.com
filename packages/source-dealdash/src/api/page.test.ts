/**
 * Contract tests for the auction page parser. The brace-balanced
 * extractor handles strings, escapes, nested objects, and the cases
 * where DealDash's HTML has multiple `dd.auctionFeed`-shaped strings
 * embedded that aren't the actual assignment.
 */

import { describe, it, expect } from 'vitest';
import { extractAuctionFeed, readStaticEntry, entryToPageInfo, fetchAuctionPageInfo } from './page.js';
import { stubFetcher } from './fetcher.js';

const HTML_HAPPY_PATH = `
  <html><body><script>
    var foo = 1;
    dd.auctionFeed = {"auctions":{"static":{"123":{"id":123,"name":"850 Bid Pack!","categoryName":"Packs","buyItNowPrice":102,"exchangeable":false,"productId":24935,"noReEntry":false}}}};
    dd.something = 'else';
  </script></body></html>
`;

const HTML_WITH_ESCAPED_QUOTES = `
  dd.auctionFeed = {"auctions":{"static":{"99":{"id":99,"name":"He said \\"hi\\"","categoryName":"Watches","buyItNowPrice":1295}}}};
`;

const HTML_NESTED_AND_ARRAYS = `
  dd.auctionFeed = {"auctions":{"static":{"42":{"id":42,"name":"x","tags":["a","b","c"],"meta":{"a":{"b":{"c":1}}}}}}};
`;

describe('extractAuctionFeed', () => {
  it('parses the canonical assignment', () => {
    const feed = extractAuctionFeed(HTML_HAPPY_PATH);
    expect(feed).not.toBeNull();
    expect(((feed!.auctions as { static: Record<string, { name: string }> }).static)['123'].name).toBe('850 Bid Pack!');
  });

  it('handles escaped quotes inside string values without breaking the brace counter', () => {
    const feed = extractAuctionFeed(HTML_WITH_ESCAPED_QUOTES);
    expect(feed).not.toBeNull();
    const entry = readStaticEntry(feed!, 99);
    expect(entry?.name).toBe('He said "hi"');
  });

  it('handles deeply nested objects and arrays', () => {
    const feed = extractAuctionFeed(HTML_NESTED_AND_ARRAYS);
    expect(feed).not.toBeNull();
    const entry = readStaticEntry(feed!, 42) as { tags: string[]; meta: { a: { b: { c: number } } } };
    expect(entry.tags).toEqual(['a', 'b', 'c']);
    expect(entry.meta.a.b.c).toBe(1);
  });

  it('returns null when dd.auctionFeed is missing', () => {
    expect(extractAuctionFeed('<html>no feed here</html>')).toBeNull();
  });

  it('returns null when the JSON is malformed', () => {
    // Closing brace mismatched on purpose
    expect(extractAuctionFeed('dd.auctionFeed = {"a":{"b":1}; ')).toBeNull();
  });
});

describe('readStaticEntry', () => {
  it('returns null when no static block exists', () => {
    expect(readStaticEntry({ auctions: {} }, 1)).toBeNull();
  });
  it('looks up by string id', () => {
    const feed = { auctions: { static: { '7': { name: 'x' } } } };
    expect(readStaticEntry(feed, 7)?.name).toBe('x');
    expect(readStaticEntry(feed, '7')?.name).toBe('x');
  });
});

describe('entryToPageInfo', () => {
  it('whitelist-maps known fields and drops everything else', () => {
    const info = entryToPageInfo({
      id: 1, name: 'foo', categoryName: 'Packs', buyItNowPrice: 100,
      exchangeable: true, productId: 42, noReEntry: false,
      exchangedAt: 1000, exchangedFor: 200, somethingElse: 'ignored',
    });
    expect(info).toEqual({
      name: 'foo', categoryName: 'Packs', buyItNowPrice: 100,
      exchangeable: true, productId: 42, noReEntry: false,
      exchangedAt: 1000, exchangedFor: 200,
    });
    expect((info as Record<string, unknown>).somethingElse).toBeUndefined();
  });

  it('handles missing fields gracefully', () => {
    expect(entryToPageInfo({})).toEqual({});
  });
});

describe('fetchAuctionPageInfo (end-to-end with stub fetcher)', () => {
  it('returns parsed info on a successful response', async () => {
    const fetcher = stubFetcher((path) => {
      expect(path).toBe('/auction/123');
      return new Response(HTML_HAPPY_PATH, { status: 200 });
    });
    const info = await fetchAuctionPageInfo(fetcher, 123);
    expect(info).toEqual({
      name: '850 Bid Pack!',
      categoryName: 'Packs',
      buyItNowPrice: 102,
      exchangeable: false,
      productId: 24935,
      noReEntry: false,
    });
  });

  it('returns null on a 404', async () => {
    const fetcher = stubFetcher(() => new Response('', { status: 404 }));
    expect(await fetchAuctionPageInfo(fetcher, 999)).toBeNull();
  });

  it('returns null when the page has no feed marker', async () => {
    const fetcher = stubFetcher(() => new Response('<html>nothing</html>', { status: 200 }));
    expect(await fetchAuctionPageInfo(fetcher, 1)).toBeNull();
  });
});
