import { spawn } from 'node:child_process';

export interface NewsItem {
  uuid: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string;
}

interface BriskResponse {
  articles?: {
    uuid?: string;
    title?: string;
    url?: string;
    source?: string;
    publishedAt?: string;
  }[];
}

const BRISK_URL = 'https://brisk.news/api/news?limit=20&search=crypto+trading';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
};

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

export async function fetchNews(signal?: AbortSignal): Promise<NewsItem[]> {
  const res = await fetch(BRISK_URL, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`brisk.news ${res.status}`);
  const body = (await res.json()) as BriskResponse;
  const items = body.articles ?? [];
  return items
    .filter((a) => a.url && a.title)
    .map((a) => ({
      uuid: a.uuid ?? a.url!,
      title: decodeHtmlEntities(a.title!).replace(/\s+/g, ' ').trim(),
      url: a.url!,
      source: a.source ?? '',
      publishedAt: a.publishedAt ?? '',
    }));
}

export function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

export function formatNewsTs(iso: string): string {
  if (!iso) return '          ';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '          ';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}
