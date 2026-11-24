/** SEC Filings & Enforcement: full-text search, latest filings, a filing viewer, litigation and press releases, adviser lookup. */
import { cikFor, filingDocUrl, htmlToText, parseFeed, SEC, submissions } from '../../lib/sec.js';
import { SourceError, type CardDef, type Ctx, type Row } from '../../types.js';

interface FtsHit {
  _id?: string;
  _source?: {
    ciks?: string[];
    display_names?: string[];
    file_date?: string;
    period_ending?: string;
    form?: string;
    file_type?: string;
    file_description?: string;
    adsh?: string;
  };
}
interface FtsBody {
  hits?: { total?: { value?: number }; hits?: FtsHit[] };
  aggregations?: { entity_filter?: { buckets?: { key?: string; doc_count?: number }[] } };
}

export interface FtsRow {
  filed: string;
  form: string;
  company: string;
  document: string;
  period: string;
  url: string;
}

/** Hits of EDGAR full-text search to rows; the hit id is "accession:filename". */
export function parseFts(body: FtsBody): FtsRow[] {
  return (body.hits?.hits ?? []).flatMap((h) => {
    const s = h._source;
    const [adsh, file] = (h._id ?? '').split(':');
    const cik = s?.ciks?.[0];
    if (!s || !adsh || !file || !cik) return [];
    return [{
      filed: s.file_date ?? '',
      form: s.form ?? s.file_type ?? '',
      company: (s.display_names?.[0] ?? '').replace(/\s*\(CIK \d+\)\s*$/, '').replace(/\s+/g, ' ').trim(),
      document: s.file_description && s.file_description !== s.file_type ? `${s.file_type ?? ''} ${s.file_description}`.trim() : (s.file_type ?? ''),
      period: s.period_ending ?? '',
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, '')}/${file}`,
    }];
  });
}

const search: CardDef = {
  id: 'equities.sec-search',
  title: 'EDGAR full-text search',
  source: SEC,
  description: 'Search the text of every EDGAR filing since 2001 for a phrase, optionally limited to form types.',
  params: [
    { name: 'query', label: 'Search', default: '"artificial intelligence" tariff', hint: 'words or a "quoted phrase"; a ticker or company name also works' },
    { name: 'form', label: 'Forms', default: 'all', hint: 'all, or a comma list such as 10-K,8-K' },
  ],
  async run(ctx, params) {
    const query = (params.query || '').trim();
    if (!query) throw new SourceError(SEC, 'enter something to search for');
    const forms = (params.form ?? 'all').trim();
    const qs = `q=${encodeURIComponent(query)}${forms && forms.toLowerCase() !== 'all' ? `&forms=${encodeURIComponent(forms.toUpperCase().replace(/\s+/g, ''))}` : ''}`;
    const body = await ctx.http.json<FtsBody>(`https://efts.sec.gov/LATEST/search-index?${qs}`, { source: SEC, ttl: 900 });
    const rows = parseFts(body);
    if (!rows.length) throw new SourceError(SEC, `no filings match ${query}`);
    const filers: Row[] = (body.aggregations?.entity_filter?.buckets ?? []).slice(0, 8).map((b) => ({ filer: (b.key ?? '').replace(/\s+/g, ' ').replace(/\s*\(CIK \d+\)\s*$/, ''), count: b.doc_count ?? 0 }));
    return {
      blocks: [
        {
          kind: 'table',
          title: `${(body.hits?.total?.value ?? rows.length).toLocaleString('en-US')}${body.hits?.total?.value === 10_000 ? '+' : ''} documents match; top ${Math.min(rows.length, 40)} by relevance`,
          columns: [
            { key: 'filed', label: 'Filed' },
            { key: 'form', label: 'Form' },
            { key: 'company', label: 'Filer', maxWidth: 40 },
            { key: 'document', label: 'Document', maxWidth: 26 },
            { key: 'url', label: 'Link', maxWidth: 70 },
          ],
          rows: rows.slice(0, 40).map((r) => ({ ...r })),
        },
        ...(filers.length ? [{ kind: 'table' as const, title: 'Filers with the most matching documents', columns: [{ key: 'filer', label: 'Filer', maxWidth: 60 }, { key: 'count', label: 'Documents', format: 'int' as const }], rows: filers }] : []),
      ],
      sourceUrl: `https://efts.sec.gov/LATEST/search-index?${qs}`.replace('efts.sec.gov/LATEST/search-index?', 'www.sec.gov/edgar/search/#/'),
      notes: ['Full-text search covers filings from 2001 onward. Results are ranked by relevance, not date. Paste a link into the filing viewer to read the document.'],
    };
  },
};

const latest: CardDef = {
  id: 'equities.sec-latest',
  title: 'Latest filings by form type',
  source: SEC,
  description: 'The newest filings EDGAR has accepted for a form type, across all filers.',
  params: [{ name: 'form', label: 'Form type', default: '8-K', hint: 'e.g. 8-K, 10-K, 10-Q, S-1, 4, 13F-HR, SC 13D, DEF 14A' }],
  async run(ctx, params) {
    const form = (params.form || '8-K').trim();
    const xml = await ctx.http.text(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&company=&dateb=&owner=include&count=40&output=atom`, { source: SEC, ttl: 300 });
    const rows: Row[] = parseFeed(xml).map((e) => {
      const m = /^(.+?) - (.+?) \((\d{10})\) \(([^)]+)\)\s*$/.exec(e.title);
      const acc = /AccNo:\s*([\d-]+)/.exec(e.summary)?.[1] ?? '';
      const items = /Item[s]? [\d.]+[^F]*/i.exec(e.summary)?.[0];
      return { time: e.date, form: m?.[1] ?? form, company: m?.[2] ?? e.title, role: m?.[4] ?? '', accession: acc, detail: items?.trim() ?? '', url: e.link };
    });
    if (!rows.length) throw new SourceError(SEC, `no recent filings of type "${form}" (check the form name)`);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'time', label: 'Accepted (UTC)', format: 'datetime' },
            { key: 'form', label: 'Form' },
            { key: 'company', label: 'Company', maxWidth: 42 },
            { key: 'role', label: 'Role', maxWidth: 12 },
            { key: 'url', label: 'Filing index', maxWidth: 88 },
          ],
          rows,
        },
      ],
      sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}`,
      asOf: String(rows[0].time ?? '').slice(0, 16).replace('T', ' '),
      notes: ['Live feed of filings as EDGAR accepts them. A filing appears once per party (filer, subject company, reporting owner).'],
    };
  },
};

/** Where to fetch a filing from: an sec.gov URL, or "TICKER FORM" for a company's latest filing of that form. */
export async function resolveFiling(ctx: Ctx, input: string): Promise<{ url: string; label: string }> {
  const raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new SourceError(SEC, `not a valid URL: ${raw}`);
    }
    if (!/(^|\.)sec\.gov$/.test(u.hostname)) throw new SourceError(SEC, 'the filing viewer only opens documents on sec.gov');
    // Inline XBRL viewer links wrap the real document path.
    const doc = u.pathname === '/ix' ? (u.searchParams.get('doc') ?? '') : u.pathname;
    return { url: `https://www.sec.gov${doc}`, label: doc.split('/').pop() ?? raw };
  }
  const acc = /^(\d{10})-(\d{2})-(\d{6})$/.exec(raw);
  if (acc) {
    return { url: `https://www.sec.gov/Archives/edgar/data/${Number(acc[1])}/${raw.replace(/-/g, '')}/${raw}.txt`, label: `accession ${raw}` };
  }
  const m = /^([A-Za-z.\-]{1,8})(?:\s+(.+))?$/.exec(raw);
  if (!m) throw new SourceError(SEC, 'give an sec.gov URL, an accession number, or a ticker and form such as "AAPL 10-K"');
  const reg = await cikFor(ctx, m[1]);
  const form = (m[2] ?? '10-K').trim().toUpperCase();
  const f = (await submissions(ctx, reg.cik)).filings.find((x) => x.form.toUpperCase() === form && x.primaryDocument);
  if (!f) throw new SourceError(SEC, `no recent ${form} for ${m[1].toUpperCase()}`);
  return { url: filingDocUrl(reg.cik, f.accession, f.primaryDocument), label: `${reg.title} ${f.form} filed ${f.filingDate}` };
}

const MAX_TEXT = 14_000;

const viewer: CardDef = {
  id: 'equities.sec-filing',
  title: 'Filing viewer',
  source: SEC,
  description: 'Read a filing as plain text: give an EDGAR link, an accession number, or a ticker and form for the latest one.',
  params: [
    { name: 'filing', label: 'Filing', default: 'AAPL 8-K', hint: 'sec.gov URL, accession number, or "TICKER FORM" such as MSFT 10-Q' },
    { name: 'find', label: 'Jump to', default: '', hint: 'optional text to start the excerpt at' },
  ],
  async run(ctx, params) {
    const { url, label } = await resolveFiling(ctx, params.filing || 'AAPL 8-K');
    const raw = await ctx.http.text(url, { source: SEC, ttl: 21_600, timeoutMs: 60_000 });
    const text = /<html|<body|<div|<p[ >]/i.test(raw) ? htmlToText(raw.replace(/^[\s\S]{0,600}?<TEXT>/i, '')) : raw.replace(/\r/g, '').trim();
    if (!text) throw new SourceError(SEC, `the document at ${url} has no readable text (it may be a PDF or an image)`);
    const find = (params.find ?? '').trim();
    let start = 0;
    let missed = false;
    if (find) {
      const at = text.toLowerCase().indexOf(find.toLowerCase());
      if (at >= 0) start = Math.max(0, at - 200);
      else missed = true;
    }
    const excerpt = text.slice(start, start + MAX_TEXT);
    return {
      blocks: [
        { kind: 'stats', items: [{ label: 'Length (characters)', value: text.length, format: 'int' }, { label: 'Showing from', value: start, format: 'int' }] },
        { kind: 'text', title: label, text: `${start > 0 ? '[...]\n' : ''}${excerpt}${start + MAX_TEXT < text.length ? '\n\n[...]' : ''}` },
      ],
      sourceUrl: url,
      notes: [
        text.length > MAX_TEXT ? `Showing ${MAX_TEXT.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters. Use "find" to jump to a heading or phrase (e.g. "Item 7").` : 'Full text; tables are flattened.',
        ...(missed ? [`"${find}" was not found; showing the start of the document.`] : []),
      ],
    };
  },
};

function feedCard(id: string, title: string, description: string, feed: string, page: string): CardDef {
  return {
    id,
    title,
    source: 'SEC',
    description,
    async run(ctx) {
      const items = parseFeed(await ctx.http.text(feed, { source: 'SEC', ttl: 900 }));
      if (!items.length) throw new SourceError('SEC', 'the feed has no items');
      // Litigation releases repeat the title as the description; keep the column only when it adds something.
      const withSummary = items.some((i) => i.summary && i.summary !== i.title);
      return {
        blocks: [
          {
            kind: 'table',
            columns: [
              { key: 'date', label: 'Date', format: 'date' },
              { key: 'title', label: 'Title', maxWidth: 80 },
              ...(withSummary ? [{ key: 'summary', label: 'Summary', maxWidth: 60 }] : []),
              { key: 'link', label: 'Link', maxWidth: withSummary ? 70 : 110 },
            ],
            rows: items.slice(0, 40).map((i) => ({ ...i })),
          },
        ],
        sourceUrl: page,
        asOf: items[0].date.slice(0, 10),
      };
    },
  };
}

const litigation = feedCard('equities.sec-litigation', 'SEC litigation releases', 'Civil enforcement actions the SEC has brought in federal court.', 'https://www.sec.gov/enforcement-litigation/litigation-releases/rss', 'https://www.sec.gov/enforcement-litigation/litigation-releases');
const press = feedCard('equities.sec-press', 'SEC press releases', 'Official SEC announcements: rule proposals, enforcement actions, appointments.', 'https://www.sec.gov/news/pressreleases.rss', 'https://www.sec.gov/newsroom/press-releases');

interface AdvHit {
  _source?: {
    firm_source_id?: string;
    firm_name?: string;
    firm_ia_full_sec_number?: string;
    firm_ia_scope?: string;
    firm_ia_disclosure_fl?: string;
    firm_branches_count?: number;
    firm_other_names?: string[];
    firm_ia_address_details?: string;
  };
}

export function parseAdvHits(hits: AdvHit[]): Row[] {
  return hits.flatMap((h) => {
    const s = h._source;
    if (!s?.firm_name) return [];
    let where = '';
    try {
      const a = (JSON.parse(s.firm_ia_address_details ?? '{}') as { officeAddress?: { city?: string; state?: string; country?: string } }).officeAddress;
      where = [a?.city, a?.state, a?.country && a.country !== 'United States' ? a.country : ''].filter(Boolean).join(', ');
    } catch {
      where = '';
    }
    return [{
      firm: s.firm_name,
      sec: s.firm_ia_full_sec_number ?? '',
      crd: s.firm_source_id ?? '',
      status: s.firm_ia_scope ?? '',
      disclosures: s.firm_ia_disclosure_fl === 'Y' ? 'Yes' : s.firm_ia_disclosure_fl === 'N' ? 'No' : '',
      office: where,
      aka: (s.firm_other_names ?? []).filter((n) => n !== s.firm_name).slice(0, 2).join('; '),
      url: s.firm_source_id ? `https://adviserinfo.sec.gov/firm/summary/${s.firm_source_id}` : '',
    }];
  });
}

const adv: CardDef = {
  id: 'equities.sec-adv',
  title: 'Investment adviser lookup (Form ADV)',
  source: 'SEC IAPD',
  description: 'Find a registered investment adviser by name: SEC number, CRD, registration status, disclosures and main office.',
  params: [{ name: 'query', label: 'Adviser name', default: 'Bridgewater', hint: 'firm name or CRD number' }],
  async run(ctx, params) {
    const query = (params.query || 'Bridgewater').trim();
    const body = await ctx.http.json<{ hits?: { total?: number; hits?: AdvHit[] } }>(`https://api.adviserinfo.sec.gov/search/firm?query=${encodeURIComponent(query)}&hl=true&nrows=25&start=0&r=25&sort=score%2Bdesc&wt=json`, { source: 'SEC IAPD', ttl: 3600 });
    const rows = parseAdvHits(body.hits?.hits ?? []);
    if (!rows.length) throw new SourceError('SEC IAPD', `no adviser firm matches "${query}"`);
    return {
      blocks: [
        {
          kind: 'table',
          title: `${body.hits?.total ?? rows.length} firms match "${query}"`,
          columns: [
            { key: 'firm', label: 'Firm', maxWidth: 40 },
            { key: 'sec', label: 'SEC no.' },
            { key: 'crd', label: 'CRD' },
            { key: 'status', label: 'Status' },
            { key: 'disclosures', label: 'Disclosures' },
            { key: 'office', label: 'Main office', maxWidth: 28 },
            { key: 'aka', label: 'Also known as', maxWidth: 34 },
            { key: 'url', label: 'Form ADV', maxWidth: 52 },
          ],
          rows,
        },
      ],
      sourceUrl: `https://adviserinfo.sec.gov/search/genericsearch/firmgrid?query=${encodeURIComponent(query)}`,
      notes: ['From the SEC Investment Adviser Public Disclosure site. "Disclosures" says whether the firm reports any regulatory, criminal or civil events on Form ADV; open the link for the filing itself (assets under management, clients, fees).'],
    };
  },
};

export const secCards: CardDef[] = [search, latest, viewer, litigation, press, adv];
