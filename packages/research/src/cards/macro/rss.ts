/**
 * A small RSS 2.0 / RSS 1.0 / Atom reader. No dependencies: feeds are simple
 * enough that a tolerant scanner is more robust than a strict XML parser
 * against the malformed markup real publishers ship.
 */

export interface FeedItem {
  title: string;
  link: string;
  /** ms since epoch, or null when the feed gives no usable date. */
  date: number | null;
  summary: string;
  id: string;
}

export interface Feed {
  title: string;
  items: FeedItem[];
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', euro: 'EUR', pound: 'GBP', yen: 'JPY', copy: '(c)', reg: '(R)', trade: '(TM)',
};

/** Decode XML/HTML character references. Unknown names are left as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Element content to plain text: unwrap CDATA, decode entities, drop markup, collapse whitespace. */
export function plainText(raw: string): string {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner);
  // Escaped markup ("&lt;p&gt;") becomes real markup after one decode, so decode first, then strip tags, then decode what is left.
  s = decodeEntities(s);
  s = s.replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Inner text of the first `<name>` child (any namespace prefix given explicitly, e.g. "dc:date"). */
function child(block: string, name: string): string | undefined {
  const m = new RegExp(`<${escapeRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRe(name)}\\s*>`, 'i').exec(block);
  return m ? m[1] : undefined;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${escapeRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : undefined;
}

/** Atom links are attributes: prefer rel="alternate" (or no rel) over self/enclosure links. */
function atomLink(block: string): string | undefined {
  const tags = block.match(/<link\b[^>]*>/gi) ?? [];
  let fallback: string | undefined;
  for (const t of tags) {
    const href = attr(t, 'href');
    if (!href) continue;
    const rel = attr(t, 'rel');
    if (!rel || rel === 'alternate') return href;
    fallback ??= href;
  }
  return fallback;
}

/** Feed dates: RFC 822 (RSS) or ISO 8601 (Atom, Dublin Core). */
export function parseFeedDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = plainText(raw);
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  // "24 Nov 2026 08:30:09 EST" style zones some engines reject: retry without the zone name.
  const t2 = Date.parse(s.replace(/\s+[A-Z]{2,5}$/, ' GMT'));
  return Number.isNaN(t2) ? null : t2;
}

function firstChild(block: string, names: string[]): string | undefined {
  for (const n of names) {
    const v = child(block, n);
    if (v !== undefined && v.trim() !== '') return v;
  }
  return undefined;
}

export function parseFeed(xml: string): Feed {
  const items: FeedItem[] = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
  let m: RegExpExecArray | null;
  let firstItemAt = -1;
  while ((m = re.exec(xml)) !== null) {
    if (firstItemAt < 0) firstItemAt = m.index;
    const block = m[2];
    const title = plainText(child(block, 'title') ?? '');
    const textLink = child(block, 'link');
    const link = (textLink && plainText(textLink)) || atomLink(block) || '';
    const date = parseFeedDate(firstChild(block, ['pubDate', 'dc:date', 'published', 'updated', 'date']));
    const summary = plainText(firstChild(block, ['description', 'summary', 'content:encoded', 'content']) ?? '');
    const id = plainText(firstChild(block, ['guid', 'id']) ?? '') || link || title;
    if (!title && !link) continue;
    items.push({ title, link, date, summary, id });
  }
  const head = firstItemAt < 0 ? xml : xml.slice(0, firstItemAt);
  return { title: plainText(child(head, 'title') ?? ''), items };
}
