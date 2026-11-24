/**
 * Folding duplicate headlines: the same story arrives from several feeds
 * with slightly different wording. Titles are normalised to a set of
 * significant words and compared by overlap.
 */

export interface Headline {
  title: string;
  link: string;
  source: string;
  /** ms since epoch; null when the feed gave no date. */
  date: number | null;
}

export interface FoldedHeadline extends Headline {
  /** Every source that carried the story, the shown one first. */
  sources: string[];
  /** How many feed items were folded into this row (1 = unique). */
  count: number;
}

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'its', 'this', 'that', 'after', 'over', 'amid', 'into', 'than', 'has', 'have', 'had', 'will',
  'says', 'say', 'said', 'new', 'us', 'vs',
]);

/** Lower-case significant words of a headline, without a trailing "- Publisher" or "| Publisher". */
export function titleTokens(title: string): string[] {
  let s = title.toLowerCase();
  s = s.replace(/\s+[-|–—]\s+[^-|–—]{2,40}$/, '');
  s = s.replace(/['‘’]s\b/g, '').replace(/['‘’]/g, '');
  const words = s.replace(/[^a-z0-9%.]+/g, ' ').split(' ');
  const out: string[] = [];
  for (const raw of words) {
    const w = raw.replace(/^\.+|\.+$/g, '');
    if (!w || STOP.has(w)) continue;
    if (w.length < 2 && !/\d/.test(w)) continue;
    out.push(w);
  }
  return out;
}

export function normaliseTitle(title: string): string {
  return titleTokens(title).join(' ');
}

/** Jaccard overlap of the two titles' word sets, 0 to 1. */
export function titleSimilarity(a: string, b: string): number {
  return tokenSimilarity(new Set(titleTokens(a)), new Set(titleTokens(b)));
}

function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Newest first, with near-duplicate titles folded into the newest copy.
 * Undated items sort last. `threshold` is the word-set overlap at which two
 * titles count as one story.
 */
export function foldHeadlines(items: Headline[], threshold = 0.6): FoldedHeadline[] {
  const sorted = [...items].sort((x, y) => (y.date ?? -Infinity) - (x.date ?? -Infinity));
  const out: { row: FoldedHeadline; tokens: Set<string> }[] = [];
  for (const it of sorted) {
    const tokens = new Set(titleTokens(it.title));
    const match = tokens.size >= 3 ? out.find((o) => tokenSimilarity(o.tokens, tokens) >= threshold) : out.find((o) => o.tokens.size === tokens.size && tokenSimilarity(o.tokens, tokens) === 1);
    if (match) {
      match.row.count += 1;
      if (!match.row.sources.includes(it.source)) match.row.sources.push(it.source);
    } else out.push({ row: { ...it, sources: [it.source], count: 1 }, tokens });
  }
  return out.map((o) => o.row);
}
