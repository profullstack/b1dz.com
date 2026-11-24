/** Company > Ownership, Dividends, Filings and Shorts. */
import { csvObjects, firstOf, num } from '../../http.js';
import { getQuote } from '../../lib/market.js';
import { NASDAQ, nasdaqGet, nasdaqInfo, nasdaqSymbol } from '../../lib/nasdaq.js';
import { cikFor, companyFacts, filingDocUrl, filingIndexUrl, htmlToText, SEC, submissions, type CompanyFacts } from '../../lib/sec.js';
import { SourceError, type CardDef, type CardResult, type ChartBlock, type Row, type StatItem } from '../../types.js';
import { SYMBOL, symbolOf, usDate } from './util.js';
import { flows, pickFacts, quarterly } from './xbrl.js';

const api = (symbol: string): string => encodeURIComponent(nasdaqSymbol(symbol));
const page = (symbol: string, p: string): string => `https://www.nasdaq.com/market-activity/stocks/${nasdaqSymbol(symbol).toLowerCase()}/${p}`;

interface LabelTable {
  rows?: Record<string, string>[] | null;
}
interface Insiders {
  numberOfTrades?: LabelTable | null;
  numberOfSharesTraded?: LabelTable | null;
  transactionTable?: { table?: { rows?: Record<string, string>[] | null } | null } | null;
}

const insiders: CardDef = {
  id: 'equities.insiders',
  title: 'Insider transactions',
  source: NASDAQ,
  description: 'Recent Form 4 trades by officers and directors, with buy and sell counts over three and twelve months.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const d = await nasdaqGet<Insiders>(ctx, `/api/company/${api(symbol)}/insider-trades?limit=40&type=ALL&sortColumn=lastDate&sortOrder=DESC`, 3600);
    const rows: Row[] = (d.transactionTable?.table?.rows ?? []).map((r) => {
      const shares = num(r.sharesTraded);
      const price = num(r.lastPrice);
      return {
        date: usDate(r.lastDate),
        insider: r.insider,
        relation: r.relation,
        type: r.transactionType,
        shares,
        price,
        value: shares !== null && price !== null ? shares * price : null,
        held: num(r.sharesHeld),
      };
    });
    if (!rows.length) throw new SourceError(NASDAQ, `no insider transactions on file for ${symbol}`);
    const items: StatItem[] = [];
    for (const t of [d.numberOfTrades, d.numberOfSharesTraded]) {
      for (const r of t?.rows ?? []) {
        const label = (r.insiderTrade ?? '').replace(/^Number of /, '').replace(/^Total /, '');
        items.push({ label: `${label} 3M`, value: num(r.months3), format: 'int' });
        items.push({ label: `${label} 12M`, value: num(r.months12), format: 'int' });
      }
    }
    return {
      blocks: [
        ...(items.length ? [{ kind: 'stats' as const, items }] : []),
        {
          kind: 'table',
          columns: [
            { key: 'date', label: 'Date' },
            { key: 'insider', label: 'Insider', maxWidth: 28 },
            { key: 'relation', label: 'Relation', maxWidth: 14 },
            { key: 'type', label: 'Transaction', maxWidth: 22 },
            { key: 'shares', label: 'Shares', format: 'int' },
            { key: 'price', label: 'Price', format: 'usd' },
            { key: 'value', label: 'Value', format: 'usdCompact' },
            { key: 'held', label: 'Held after', format: 'int' },
          ],
          rows,
        },
      ],
      sourceUrl: page(symbol, 'insider-activity'),
      asOf: String(rows[0].date),
      notes: ['Compiled by Nasdaq from SEC Form 4 filings. "Automatic" trades are under pre-arranged Rule 10b5-1 plans; a blank price is a grant, gift or exercise with no market price.'],
    };
  },
};

interface Holdings {
  ownershipSummary?: Record<string, { label?: string; value?: string } | undefined> | null;
  activePositions?: LabelTable | null;
  newSoldOutPositions?: LabelTable | null;
  holdingsTransactions?: { table?: { rows?: Record<string, string>[] | null } | null } | null;
}

const institutions: CardDef = {
  id: 'equities.institutions',
  title: 'Institutional holders (13F)',
  source: NASDAQ,
  description: 'Largest institutional holders from Form 13F filings, with the share of the company held by institutions and position changes.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const d = await nasdaqGet<Holdings>(ctx, `/api/company/${api(symbol)}/institutional-holdings?limit=30&type=TOTAL&sortColumn=marketValue&sortOrder=DESC`, 21_600);
    const rows: Row[] = (d.holdingsTransactions?.table?.rows ?? []).map((r) => ({
      holder: r.ownerName,
      date: usDate(r.date),
      shares: num(r.sharesHeld),
      change: num(r.sharesChange),
      changePct: num(r.sharesChangePCT),
      value: (num(r.marketValue) ?? NaN) * 1000 || null,
    }));
    if (!rows.length) throw new SourceError(NASDAQ, `no institutional holdings on file for ${symbol}`);
    const s = d.ownershipSummary ?? {};
    const items: StatItem[] = [
      { label: 'Institutional ownership', value: num(s.SharesOutstandingPCT?.value), format: 'pct' },
      { label: 'Shares outstanding', value: (num(s.ShareoutstandingTotal?.value) ?? NaN) * 1e6 || null, format: 'compact' },
      { label: 'Value of holdings', value: (num(s.TotalHoldingsValue?.value) ?? NaN) * 1e6 || null, format: 'usdCompact' },
    ];
    for (const r of [...(d.activePositions?.rows ?? []), ...(d.newSoldOutPositions?.rows ?? [])]) {
      const label = (r.positions ?? '').replace(/ Positions$/, '').replace(/^Total Institutional Shares$/, 'All');
      items.push({ label: `${label}: holders`, value: num(r.holders), format: 'int' });
      items.push({ label: `${label}: shares`, value: num(r.shares), format: 'compact' });
    }
    return {
      blocks: [
        { kind: 'stats', items },
        {
          kind: 'table',
          title: 'Largest holders by value',
          columns: [
            { key: 'holder', label: 'Holder', maxWidth: 40 },
            { key: 'date', label: 'Report date' },
            { key: 'shares', label: 'Shares', format: 'int' },
            { key: 'change', label: 'Change', format: 'signed', digits: 0 },
            { key: 'changePct', label: 'Change %', format: 'signedPct' },
            { key: 'value', label: 'Value', format: 'usdCompact' },
          ],
          rows,
        },
      ],
      sourceUrl: page(symbol, 'institutional-holdings'),
      notes: ['Compiled by Nasdaq from SEC Form 13F filings, which are quarterly and filed up to 45 days after quarter end; each row carries its own report date.'],
    };
  },
};

interface Dividends {
  exDividendDate?: string;
  dividendPaymentDate?: string;
  yield?: string;
  annualizedDividend?: string;
  payoutRatio?: string;
  dividends?: { rows?: { exOrEffDate?: string; type?: string; amount?: string; declarationDate?: string; recordDate?: string; paymentDate?: string }[] | null } | null;
}

/** Cash paid per calendar year of the ex-date, oldest first. */
export function dividendsByYear(rows: { date: string; amount: number | null }[]): { year: number; total: number; count: number }[] {
  const by = new Map<number, { total: number; count: number }>();
  for (const r of rows) {
    const y = Number(r.date.slice(0, 4));
    if (!(y > 1900) || r.amount === null) continue;
    const e = by.get(y) ?? { total: 0, count: 0 };
    e.total += r.amount;
    e.count += 1;
    by.set(y, e);
  }
  return [...by.entries()].map(([year, v]) => ({ year, ...v })).sort((a, b) => a.year - b.year);
}

/** Dividends declared per share by fiscal quarter, from XBRL (used where the exchange feed has no history). */
export function declaredDividends(cf: CompanyFacts): { date: string; amount: number; derived: boolean }[] {
  const q = quarterly(flows(pickFacts(cf, ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'], 'USD/shares', 'last')));
  return q.filter((x) => x.val > 0).map((x) => ({ date: x.end, amount: Math.round(x.val * 1e6) / 1e6, derived: Boolean(x.derived) })).reverse();
}

const dividends: CardDef = {
  id: 'equities.dividends',
  title: 'Dividend history and yield',
  source: NASDAQ,
  description: 'Current yield and annual rate, cash dividends per share by year, and each payment (ex, record and pay dates where the exchange publishes them).',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const firstYear = ctx.now().getUTCFullYear() - 11;
    const yearChart = (rows: { date: string; amount: number | null }[], title: string): ChartBlock => {
      const years = dividendsByYear(rows).filter((y) => y.year >= firstYear);
      return { kind: 'chart', title, xType: 'category', style: 'bar', categories: years.map((y) => String(y.year)), series: [{ name: 'Dividends', points: years.map((y, i) => [i, y.total]) }], yFormat: 'usd' };
    };

    const fromNasdaq = async (): Promise<CardResult> => {
      const { cls } = await nasdaqInfo(ctx, symbol);
      const d = await nasdaqGet<Dividends>(ctx, `/api/quote/${api(symbol)}/dividends?assetclass=${cls}`, 21_600);
      const rows = (d.dividends?.rows ?? []).map((r) => ({
        date: usDate(r.exOrEffDate),
        type: r.type ?? '',
        amount: num(r.amount),
        declared: usDate(r.declarationDate),
        record: usDate(r.recordDate),
        paid: usDate(r.paymentDate),
      }));
      if (!rows.length) throw new SourceError(NASDAQ, 'publishes dividend history for Nasdaq-listed securities only');
      const items: StatItem[] = [
        { label: 'Dividend yield', value: num(d.yield), format: 'pct' },
        { label: 'Annual rate', value: num(d.annualizedDividend), format: 'usd' },
        { label: 'Payout ratio', value: num(d.payoutRatio), format: 'pct', digits: 1 },
        { label: 'Last ex-dividend date', value: usDate(d.exDividendDate) },
        { label: 'Last payment date', value: usDate(d.dividendPaymentDate) },
        { label: 'Payments on record', value: rows.length, format: 'int' },
      ];
      return {
        blocks: [
          { kind: 'stats', items },
          yearChart(rows.filter((r) => /cash/i.test(r.type) || r.type === ''), 'Cash dividends per share by year of ex-date'),
          {
            kind: 'table',
            columns: [
              { key: 'date', label: 'Ex-date' },
              { key: 'type', label: 'Type' },
              { key: 'amount', label: 'Amount', format: 'usd', digits: 4 },
              { key: 'declared', label: 'Declared' },
              { key: 'record', label: 'Record' },
              { key: 'paid', label: 'Paid' },
            ],
            rows: rows.slice(0, 40),
          },
        ],
        sourceUrl: `https://www.nasdaq.com/market-activity/${cls === 'etf' ? 'etf' : 'stocks'}/${nasdaqSymbol(symbol).toLowerCase()}/dividend-history`,
        asOf: rows[0].date,
        notes: ['Amounts are as paid and are not adjusted for later stock splits, so a per-year total falls after a split. The current calendar year is partial.'],
      };
    };

    const fromSec = async (): Promise<CardResult> => {
      const reg = await cikFor(ctx, symbol);
      const rows = declaredDividends(await companyFacts(ctx, reg.cik));
      if (!rows.length) throw new SourceError(SEC, `${symbol} reports no dividends per share in its filings`);
      const quote = await getQuote(ctx, symbol).catch(() => null);
      const recent = rows.filter((r) => Date.parse(rows[0].date) - Date.parse(r.date) < 340 * 86_400_000);
      const ttm = recent.reduce((a, r) => a + r.amount, 0);
      const items: StatItem[] = [
        { label: 'Declared, trailing 4Q', value: ttm, format: 'usd' },
        { label: 'Dividend yield', value: quote?.price ? (ttm / quote.price) * 100 : null, format: 'pct' },
        { label: 'Latest quarter', value: rows[0].amount, format: 'usd', digits: 4 },
        { label: 'Quarter ended', value: rows[0].date },
        { label: 'Last price', value: quote?.price, format: 'usd' },
        { label: 'Quarters on record', value: rows.length, format: 'int' },
      ];
      return {
        blocks: [
          { kind: 'stats', items },
          yearChart(rows, 'Dividends declared per share by calendar year of the quarter'),
          {
            kind: 'table',
            columns: [
              { key: 'date', label: 'Fiscal quarter end' },
              { key: 'amount', label: 'Declared per share', format: 'usd', digits: 4 },
              { key: 'note', label: '' },
            ],
            rows: rows.slice(0, 40).map((r) => ({ date: r.date, amount: r.amount, note: r.derived ? 'Q4 = year - 9M' : '' })),
          },
        ],
        sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${reg.cik}&type=10-Q`,
        asOf: rows[0].date,
        notes: [
          'Dividends declared per common share in each fiscal quarter, from the XBRL data in 10-Q and 10-K filings (latest restated value, so comparable across splits). Ex-dividend and payment dates are not in this data.',
          'Yield = dividends declared over the last four quarters / last price. The fourth quarter is the fiscal year minus the first three quarters.',
        ],
      };
    };

    const got = await firstOf([{ name: NASDAQ, run: fromNasdaq }, { name: SEC, run: fromSec }]);
    return { ...got.value, source: got.source, notes: [...(got.value.notes ?? []), ...got.skipped] };
  },
};

interface Shorts {
  shortInterestTable?: { rows?: { settlementDate?: string; interest?: string; avgDailyShareVolume?: string; daysToCover?: number }[] | null } | null;
}

export interface ShortRow {
  date: string;
  interest: number | null;
  adv: number | null;
  days: number | null;
}

/** FINRA consolidated short interest (CSV with a header row) to rows, newest first. */
export function parseFinraShort(csv: string): ShortRow[] {
  return csvObjects(csv)
    .map((r) => ({ date: (r.settlementDate ?? '').slice(0, 10), interest: num(r.currentShortPositionQuantity), adv: num(r.averageDailyVolumeQuantity), days: num(r.daysToCoverQuantity) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.interest !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
}

const FINRA = 'FINRA';

const shortInterest: CardDef = {
  id: 'equities.short-interest',
  title: 'Short interest',
  source: FINRA,
  description: 'Shares sold short at each twice-monthly settlement date, average daily volume and days to cover, for the last two years.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const now = ctx.now();
    const fromFinra = async (): Promise<ShortRow[]> => {
      const csv = await ctx.http.text('https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest', {
        source: FINRA,
        ttl: 21_600,
        method: 'POST',
        headers: { accept: 'text/plain' },
        body: {
          compareFilters: [{ compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: nasdaqSymbol(symbol) }],
          dateRangeFilters: [{ fieldName: 'settlementDate', startDate: `${now.getUTCFullYear() - 2}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`, endDate: now.toISOString().slice(0, 10) }],
          limit: 1000,
        },
      });
      const rows = parseFinraShort(csv);
      if (!rows.length) throw new SourceError(FINRA, `no short interest reported for ${symbol}`);
      return rows;
    };
    const fromNasdaq = async (): Promise<ShortRow[]> => {
      const { cls } = await nasdaqInfo(ctx, symbol);
      const d = await nasdaqGet<Shorts>(ctx, `/api/quote/${api(symbol)}/short-interest?assetclass=${cls}`, 21_600);
      const rows = (d.shortInterestTable?.rows ?? []).map((r) => ({ date: usDate(r.settlementDate), interest: num(r.interest), adv: num(r.avgDailyShareVolume), days: r.daysToCover ?? null }));
      if (!rows.length) throw new SourceError(NASDAQ, 'publishes short interest for Nasdaq-listed securities only');
      return rows;
    };
    const got = await firstOf([{ name: FINRA, run: fromFinra }, { name: 'FINRA via Nasdaq', run: fromNasdaq }]);
    const rows = got.value;
    const out: Row[] = rows.map((r, i) => {
      const prev = rows[i + 1];
      return { ...r, change: prev && prev.interest && r.interest !== null ? ((r.interest - prev.interest) / prev.interest) * 100 : null };
    });
    const asc = [...rows].reverse();
    return {
      blocks: [
        { kind: 'chart', title: `${symbol} shares sold short`, xType: 'time', series: [{ name: 'Short interest', points: asc.filter((r) => r.interest !== null).map((r) => [Date.parse(`${r.date}T00:00:00Z`), r.interest!]) }], yFormat: 'compact' },
        {
          kind: 'table',
          columns: [
            { key: 'date', label: 'Settlement date' },
            { key: 'interest', label: 'Short interest', format: 'int' },
            { key: 'change', label: 'Change', format: 'signedPct' },
            { key: 'adv', label: 'Avg daily volume', format: 'int' },
            { key: 'days', label: 'Days to cover', format: 'num', digits: 2 },
          ],
          rows: out.slice(0, 48),
        },
      ],
      source: got.source,
      sourceUrl: 'https://www.finra.org/finra-data/browse-catalog/equity-short-interest/data',
      asOf: rows[0].date,
      notes: ['Short interest is reported by broker-dealers to FINRA twice a month and published about a week after each settlement date. Days to cover = short interest / average daily volume.', ...got.skipped],
    };
  },
};

const FORM = { name: 'form', label: 'Form type', default: 'all', hint: 'all, or a form such as 10-K, 10-Q, 8-K, 4, DEF 14A' };

const filings: CardDef = {
  id: 'equities.filings',
  title: 'Recent SEC filings',
  source: SEC,
  description: "The company's latest EDGAR filings: form, dates, description and a link to the document.",
  params: [SYMBOL, FORM],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const reg = await cikFor(ctx, symbol);
    const sub = await submissions(ctx, reg.cik);
    const want = (params.form ?? 'all').trim().toUpperCase();
    const list = sub.filings.filter((f) => want === 'ALL' || want === '' || f.form.toUpperCase() === want || f.form.toUpperCase().startsWith(`${want}/`));
    if (!list.length) throw new SourceError(SEC, `no ${want} filings among the latest ${sub.filings.length} for ${symbol}`);
    const rows: Row[] = list.slice(0, 40).map((f) => ({
      filed: f.filingDate,
      form: f.form,
      period: f.reportDate,
      description: [f.description && f.description !== f.form ? f.description : '', f.items ? `Items ${f.items}` : ''].filter(Boolean).join(' - '),
      url: f.primaryDocument ? filingDocUrl(reg.cik, f.accession, f.primaryDocument) : filingIndexUrl(reg.cik, f.accession),
    }));
    return {
      blocks: [
        {
          kind: 'table',
          title: `${sub.name || reg.title} (CIK ${reg.cik})`,
          columns: [
            { key: 'filed', label: 'Filed' },
            { key: 'form', label: 'Form' },
            { key: 'period', label: 'Period' },
            { key: 'description', label: 'Description', maxWidth: 44 },
            { key: 'url', label: 'Document', maxWidth: 90 },
          ],
          rows,
        },
      ],
      sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${reg.cik}&owner=include&count=40`,
      asOf: String(rows[0].filed),
      notes: [sub.sicDescription ? `SIC ${sub.sic}: ${sub.sicDescription}.` : '', 'Form 4 rows are insider trades; 8-K item numbers say what the report covers (2.02 = results, 5.02 = officer changes).'].filter(Boolean),
    };
  },
};

const SECTIONS = {
  'risk-factors': {
    title: 'Risk Factors',
    start: /item\s*1a\s*[.:\-]?\s*risk\s*factors/gi,
    end: /item\s*1b\s*[.:\-]|item\s*1c\s*[.:\-]|item\s*2\s*[.:\-]?\s*(properties|unregistered)/i,
  },
  mda: {
    title: "Management's Discussion and Analysis",
    start: /item\s*[27]\s*[.:\-]?\s*management.{0,3}s\s*discussion/gi,
    end: /item\s*7a\s*[.:\-]|item\s*8\s*[.:\-]|item\s*3\s*[.:\-]?\s*quantitative|item\s*4\s*[.:\-]?\s*controls/i,
  },
} as const;

/**
 * The text of one item of a 10-K or 10-Q. The heading appears in the table of
 * contents and again where the section starts (and in cross references), so
 * every occurrence is tried and the longest span up to the next item wins.
 */
export function extractSection(text: string, section: keyof typeof SECTIONS): string {
  const spec = SECTIONS[section];
  let best = '';
  for (const m of text.matchAll(spec.start)) {
    const from = m.index ?? 0;
    const rest = text.slice(from + m[0].length);
    const end = spec.end.exec(rest);
    const body = text.slice(from, end ? from + m[0].length + end.index : undefined);
    // A section that runs to the end of the document without a closing item is a cross reference near the end, unless nothing better exists.
    if (end && body.length > best.length) best = body;
  }
  return best.trim();
}

const MAX_TEXT = 16_000;

const filingSections: CardDef = {
  id: 'equities.filing-sections',
  title: '10-K / 10-Q sections',
  source: SEC,
  description: 'Risk Factors or MD&A text extracted from the latest annual or quarterly report.',
  params: [
    SYMBOL,
    { name: 'section', label: 'Section', default: 'risk-factors', choices: ['risk-factors', 'mda'] },
    { name: 'form', label: 'Report', default: '10-K', choices: ['10-K', '10-Q'] },
  ],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const section = (params.section in SECTIONS ? params.section : 'risk-factors') as keyof typeof SECTIONS;
    const form = params.form === '10-Q' ? '10-Q' : '10-K';
    const reg = await cikFor(ctx, symbol);
    const sub = await submissions(ctx, reg.cik);
    const f = sub.filings.find((x) => x.form === form && x.primaryDocument);
    if (!f) throw new SourceError(SEC, `no ${form} among recent filings for ${symbol}${form === '10-K' ? ' (foreign issuers file Form 20-F or 40-F instead)' : ''}`);
    const url = filingDocUrl(reg.cik, f.accession, f.primaryDocument);
    const text = htmlToText(await ctx.http.text(url, { source: SEC, ttl: 21_600, timeoutMs: 60_000 }));
    const body = extractSection(text, section);
    if (body.length < 400) throw new SourceError(SEC, `could not locate "${SECTIONS[section].title}" in the ${form} filed ${f.filingDate} (the report may incorporate it by reference); open ${url}`);
    const cut = body.length > MAX_TEXT;
    return {
      blocks: [
        { kind: 'stats', items: [{ label: 'Report', value: `${form} for ${f.reportDate}` }, { label: 'Filed', value: f.filingDate }, { label: 'Section length', value: body.length, format: 'int' }] },
        { kind: 'text', title: SECTIONS[section].title, text: cut ? `${body.slice(0, MAX_TEXT)}\n\n[...]` : body },
      ],
      sourceUrl: url,
      asOf: f.filingDate,
      notes: [cut ? `Showing the first ${MAX_TEXT.toLocaleString('en-US')} of ${body.length.toLocaleString('en-US')} characters; open the link for the rest.` : 'Full section text; tables are flattened to text.'],
    };
  },
};

export const ownershipCards: CardDef[] = [insiders, institutions, dividends, shortInterest, filings, filingSections];
