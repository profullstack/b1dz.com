/** ETFs & Funds: profile, holdings, sector weights, N-PORT filings and holdings overlap, from SEC Form N-PORT. */
import { num } from '../../http.js';
import { NASDAQ, nasdaqGet, nasdaqInfo, nasdaqSymbol, parseTrade } from '../../lib/nasdaq.js';
import { decodeEntities, fundTickers, SEC, secSymbol, secTickers, submissions } from '../../lib/sec.js';
import { SourceError, type CardDef, type Ctx, type Row, type StatItem } from '../../types.js';
import { issuerKey, universe, type Listing } from './universe.js';
import { symbolList } from './util.js';

const FUND = { name: 'symbol', label: 'Fund', default: 'SPY', hint: 'ETF or mutual fund ticker, e.g. SPY, QQQ, IVV, VTI' };

export interface NportFiling {
  accession: string;
  filed: string;
  period: string;
  url: string;
  indexUrl: string;
}

/** Entries of an EDGAR company-browse Atom feed. */
export function parseBrowseAtom(xml: string): { accession: string; filed: string; form: string; href: string }[] {
  const out: { accession: string; filed: string; form: string; href: string }[] = [];
  const tag = (b: string, n: string): string => new RegExp(`<${n}>([^<]*)</${n}>`).exec(b)?.[1]?.trim() ?? '';
  for (const b of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const accession = tag(b, 'accession-number');
    if (accession) out.push({ accession, filed: tag(b, 'filing-date'), form: tag(b, 'filing-type'), href: tag(b, 'filing-href') });
  }
  return out;
}

interface FundRef {
  symbol: string;
  cik: number;
  seriesId?: string;
}

async function fundRef(ctx: Ctx, symbol: string): Promise<FundRef> {
  const want = secSymbol(symbol);
  const f = (await fundTickers(ctx)).find((x) => x.symbol === want);
  if (f) return { symbol: want, cik: f.cik, seriesId: f.seriesId };
  const c = (await secTickers(ctx)).find((x) => x.ticker === want);
  if (c) return { symbol: want, cik: c.cik };
  throw new SourceError(SEC, `${want} is not a fund registered with the SEC (N-PORT covers U.S. registered funds and ETFs)`);
}

async function nportFilings(ctx: Ctx, ref: FundRef): Promise<NportFiling[]> {
  if (ref.seriesId) {
    const xml = await ctx.http.text(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ref.seriesId}&type=NPORT-P&dateb=&owner=include&count=40&output=atom`, { source: SEC, ttl: 21_600 });
    const list = parseBrowseAtom(xml).filter((e) => e.form.startsWith('NPORT-P'));
    return list.map((e) => {
      const folder = e.href.replace(/\/[^/]*$/, '');
      return { accession: e.accession, filed: e.filed, period: '', url: `${folder}/primary_doc.xml`, indexUrl: e.href };
    });
  }
  const sub = await submissions(ctx, ref.cik);
  return sub.filings.filter((f) => f.form.startsWith('NPORT-P')).map((f) => {
    const folder = `https://www.sec.gov/Archives/edgar/data/${ref.cik}/${f.accession.replace(/-/g, '')}`;
    return { accession: f.accession, filed: f.filingDate, period: f.reportDate, url: `${folder}/primary_doc.xml`, indexUrl: `${folder}/${f.accession}-index.htm` };
  });
}

export interface Holding {
  name: string;
  title: string;
  cusip: string;
  isin: string;
  balance: number | null;
  units: string;
  currency: string;
  valueUsd: number | null;
  pct: number | null;
  assetCat: string;
  issuerCat: string;
  country: string;
}

export interface Portfolio {
  registrant: string;
  series: string;
  periodDate: string;
  fiscalYearEnd: string;
  totalAssets: number | null;
  netAssets: number | null;
  monthlyReturns: (number | null)[];
  holdings: Holding[];
}

/** Parse a Form N-PORT primary document (XML). Holdings come back largest first. */
export function parseNport(xml: string): Portfolio {
  const tag = (b: string, n: string): string => decodeEntities(new RegExp(`<${n}>([^<]*)</${n}>`).exec(b)?.[1]?.trim() ?? '');
  const general = /<genInfo>[\s\S]*?<\/genInfo>/.exec(xml)?.[0] ?? '';
  const info = /<fundInfo>[\s\S]*?<\/fundInfo>/.exec(xml)?.[0] ?? '';
  const rtn = /<monthlyTotReturn\b([^>]*)\/?>/.exec(info)?.[1] ?? '';
  const holdings: Holding[] = [];
  for (const b of xml.match(/<invstOrSec>[\s\S]*?<\/invstOrSec>/g) ?? []) {
    holdings.push({
      name: tag(b, 'name'),
      title: tag(b, 'title'),
      cusip: tag(b, 'cusip'),
      isin: /<isin value="([^"]*)"/.exec(b)?.[1] ?? '',
      balance: num(tag(b, 'balance')),
      units: tag(b, 'units'),
      currency: tag(b, 'curCd'),
      valueUsd: num(tag(b, 'valUSD')),
      pct: num(tag(b, 'pctVal')),
      assetCat: tag(b, 'assetCat') || (/<assetConditional[^>]*assetCat="([^"]*)"/.exec(b)?.[1] ?? ''),
      issuerCat: tag(b, 'issuerCat') || (/<issuerConditional[^>]*issuerCat="([^"]*)"/.exec(b)?.[1] ?? ''),
      country: tag(b, 'invCountry'),
    });
  }
  holdings.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  return {
    registrant: tag(general, 'regName'),
    series: tag(general, 'seriesName'),
    periodDate: tag(general, 'repPdDate'),
    fiscalYearEnd: tag(general, 'repPdEnd'),
    totalAssets: num(tag(info, 'totAssets')),
    netAssets: num(tag(info, 'netAssets')),
    monthlyReturns: ['rtn1', 'rtn2', 'rtn3'].map((k) => num(new RegExp(`${k}="([^"]*)"`).exec(rtn)?.[1])),
    holdings,
  };
}

const portfolios = new Map<string, { at: number; value: { portfolio: Portfolio; filing: NportFiling; filings: NportFiling[] } }>();

async function loadPortfolio(ctx: Ctx, symbol: string): Promise<{ portfolio: Portfolio; filing: NportFiling; filings: NportFiling[] }> {
  const key = secSymbol(symbol);
  const hit = portfolios.get(key);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.value;
  const filings = await nportFilings(ctx, await fundRef(ctx, key));
  if (!filings.length) throw new SourceError(SEC, `no Form N-PORT filings found for ${key}`);
  const filing = filings[0];
  const xml = await ctx.http.text(filing.url, { source: SEC, ttl: 21_600, timeoutMs: 60_000 });
  const portfolio = parseNport(xml);
  if (!portfolio.holdings.length) throw new SourceError(SEC, `the latest N-PORT for ${key} lists no holdings`);
  const value = { portfolio, filing: { ...filing, period: filing.period || portfolio.periodDate }, filings };
  if (portfolios.size > 8) portfolios.delete(portfolios.keys().next().value as string);
  portfolios.set(key, { at: Date.now(), value });
  return value;
}

const NPORT_NOTE = 'Holdings are from the fund\'s latest public Form N-PORT: quarter-end positions, published about 60 days after the quarter. Weights are percent of net assets.';
const fundName = (p: Portfolio): string => (p.series && p.series !== 'N/A' ? p.series : p.registrant);

const profile: CardDef = {
  id: 'equities.etf-profile',
  title: 'Fund profile',
  source: SEC,
  description: 'Price and 52-week range with the fund\'s reported net assets, number of holdings, concentration and recent monthly total returns.',
  params: [FUND],
  async run(ctx, params) {
    const symbol = (params.symbol || 'SPY').trim().toUpperCase();
    const { portfolio: p, filing } = await loadPortfolio(ctx, symbol);
    const quote = await nasdaqInfo(ctx, symbol).catch(() => null);
    const summary = quote ? await nasdaqGet<{ summaryData?: Record<string, { value?: string } | undefined> }>(ctx, `/api/quote/${encodeURIComponent(nasdaqSymbol(symbol))}/summary?assetclass=${quote.cls}`, 300).catch(() => null) : null;
    const s = summary?.summaryData ?? {};
    const trade = parseTrade(quote?.info.primaryData);
    const [hi, lo] = (s.FiftTwoWeekHighLow?.value ?? '').split('/').map((x) => num(x));
    const top = (n: number): number => p.holdings.slice(0, n).reduce((a, h) => a + (h.pct ?? 0), 0);
    const items = ([
      { label: 'Last', value: trade.price, format: 'usd' },
      { label: 'Change', value: trade.changePct, format: 'signedPct' },
      { label: '52-week high', value: hi ?? null, format: 'usd' },
      { label: '52-week low', value: lo ?? null, format: 'usd' },
      { label: 'Market value (Nasdaq)', value: num(s.MarketCap?.value) || null, format: 'usdCompact' },
      { label: 'Net assets (N-PORT)', value: p.netAssets, format: 'usdCompact' },
      { label: 'Report date', value: p.periodDate },
      { label: 'Holdings', value: p.holdings.length, format: 'int' },
      { label: 'Top 10 weight', value: top(10), format: 'pct', digits: 1 },
      { label: 'Top 25 weight', value: top(25), format: 'pct', digits: 1 },
      { label: 'Fiscal year end', value: p.fiscalYearEnd },
    ] as StatItem[]).filter((i) => i.value !== null && i.value !== undefined && i.value !== '');
    const months = p.monthlyReturns.filter((r) => r !== null);
    return {
      blocks: [
        { kind: 'stats', title: fundName(p) === p.registrant ? p.registrant : `${fundName(p)} (${p.registrant})`, items },
        ...(months.length ? [{ kind: 'table' as const, title: 'Monthly total return in the report quarter', columns: [{ key: 'month', label: 'Month of quarter' }, { key: 'ret', label: 'Total return', format: 'signedPct' as const }], rows: p.monthlyReturns.map((r, i) => ({ month: `Month ${i + 1}`, ret: r })) }] : []),
      ],
      source: `${SEC}, ${NASDAQ}`,
      sourceUrl: filing.indexUrl,
      asOf: p.periodDate,
      notes: [NPORT_NOTE, 'Expense ratio and distribution yield are not in N-PORT and are not shown.'],
    };
  },
};

const ASSET_CATS: Record<string, string> = { EC: 'Common equity', EP: 'Preferred equity', DBT: 'Debt', STIV: 'Cash vehicle', RA: 'Repo', LON: 'Loan', DIR: 'Rate derivative', DE: 'Equity derivative', DFE: 'FX derivative', DCR: 'Credit derivative', DCO: 'Commodity derivative', COMM: 'Commodity', RE: 'Real estate', 'ABS-MBS': 'Mortgage-backed', 'ABS-O': 'Asset-backed', 'ABS-CBDO': 'CLO/CDO', SN: 'Structured note', OTHER: 'Other' };

function tickerIndex(list: Listing[]): Map<string, Listing> {
  const by = new Map<string, Listing>();
  for (const l of list) {
    const k = issuerKey(l.name);
    if (!k) continue;
    const have = by.get(k);
    if (!have || (l.marketCap ?? 0) > (have.marketCap ?? 0)) by.set(k, l);
  }
  return by;
}

const holdingsCard: CardDef = {
  id: 'equities.etf-holdings',
  title: 'Top holdings',
  source: SEC,
  description: 'The fund\'s forty largest positions with weight, value, shares or principal, asset type and country.',
  params: [FUND],
  async run(ctx, params) {
    const symbol = (params.symbol || 'SPY').trim().toUpperCase();
    const { portfolio: p, filing } = await loadPortfolio(ctx, symbol);
    const index = await universe(ctx).then(tickerIndex).catch(() => new Map<string, Listing>());
    const rows: Row[] = p.holdings.slice(0, 40).map((h, i) => ({
      rank: i + 1,
      name: h.name || h.title,
      ticker: h.assetCat === 'EC' ? (index.get(issuerKey(h.name))?.symbol ?? '') : '',
      pct: h.pct,
      value: h.valueUsd,
      balance: h.balance,
      type: ASSET_CATS[h.assetCat] ?? h.assetCat,
      country: h.country,
      cusip: h.cusip,
    }));
    return {
      blocks: [
        {
          kind: 'table',
          title: `${fundName(p)}: ${p.holdings.length} positions as of ${p.periodDate}`,
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Holding', maxWidth: 38 },
            { key: 'ticker', label: 'Ticker' },
            { key: 'pct', label: 'Weight', format: 'pct' },
            { key: 'value', label: 'Value', format: 'usdCompact' },
            { key: 'balance', label: 'Shares / par', format: 'compact' },
            { key: 'type', label: 'Type', maxWidth: 18 },
            { key: 'country', label: 'Ctry' },
            { key: 'cusip', label: 'CUSIP' },
          ],
          rows,
        },
      ],
      sourceUrl: filing.indexUrl,
      asOf: p.periodDate,
      notes: [NPORT_NOTE, 'Tickers are matched by issuer name against U.S. listings and are blank when there is no confident match; N-PORT itself identifies holdings by CUSIP and ISIN.'],
    };
  },
};

/** Sum of weights by key, largest first. */
export function weightBy<T>(items: T[], key: (x: T) => string, weight: (x: T) => number | null): { key: string; weight: number; count: number }[] {
  const by = new Map<string, { weight: number; count: number }>();
  for (const it of items) {
    const k = key(it) || 'Unclassified';
    const e = by.get(k) ?? { weight: 0, count: 0 };
    e.weight += weight(it) ?? 0;
    e.count += 1;
    by.set(k, e);
  }
  return [...by.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.weight - a.weight);
}

const sectorsCard: CardDef = {
  id: 'equities.etf-sectors',
  title: 'Sector, asset and country weights',
  source: SEC,
  description: 'Fund weights by sector (equity holdings matched to their listed sector), by asset type and by country.',
  params: [FUND],
  async run(ctx, params) {
    const symbol = (params.symbol || 'SPY').trim().toUpperCase();
    const { portfolio: p, filing } = await loadPortfolio(ctx, symbol);
    const index = tickerIndex(await universe(ctx));
    const equity = p.holdings.filter((h) => h.assetCat === 'EC');
    const equityWeight = equity.reduce((a, h) => a + (h.pct ?? 0), 0);
    const bySector = weightBy(equity, (h) => index.get(issuerKey(h.name))?.sector ?? '', (h) => h.pct);
    const unmatched = bySector.find((s) => s.key === 'Unclassified')?.weight ?? 0;
    const table = (title: string, label: string, rows: { key: string; weight: number; count: number }[]): { kind: 'table'; title: string; columns: { key: string; label: string; format?: 'pct' | 'int'; maxWidth?: number }[]; rows: Row[] } => ({
      kind: 'table',
      title,
      columns: [{ key: 'key', label, maxWidth: 30 }, { key: 'weight', label: 'Weight', format: 'pct' }, { key: 'count', label: 'Positions', format: 'int' }],
      rows: rows.slice(0, 15).map((r) => ({ ...r })),
    });
    const blocks = [];
    if (equityWeight > 1) {
      blocks.push({ kind: 'chart' as const, title: 'Equity sector weights (% of net assets)', xType: 'category' as const, style: 'bar' as const, categories: bySector.map((s) => s.key), series: [{ name: 'Weight', points: bySector.map((s, i) => [i, s.weight] as [number, number]) }], yFormat: 'pct' as const });
      blocks.push(table('By sector (common equity)', 'Sector', bySector));
    }
    blocks.push(table('By asset type', 'Asset type', weightBy(p.holdings, (h) => ASSET_CATS[h.assetCat] ?? h.assetCat, (h) => h.pct)));
    blocks.push(table('By country', 'Country', weightBy(p.holdings, (h) => h.country, (h) => h.pct)));
    return {
      blocks,
      source: `${SEC}, ${NASDAQ}`,
      sourceUrl: filing.indexUrl,
      asOf: p.periodDate,
      notes: [
        NPORT_NOTE,
        equityWeight > 1
          ? `N-PORT has no sector field: each common-stock holding is matched by issuer name to its Nasdaq sector. ${unmatched.toFixed(1)}% of net assets could not be matched ("Unclassified": mostly foreign or unlisted issuers).`
          : 'This fund holds almost no common equity, so there is no sector table.',
      ],
    };
  },
};

const nportList: CardDef = {
  id: 'equities.etf-nport',
  title: 'N-PORT filings',
  source: SEC,
  description: 'The fund\'s Form N-PORT portfolio reports on EDGAR, newest first.',
  params: [FUND],
  async run(ctx, params) {
    const symbol = (params.symbol || 'SPY').trim().toUpperCase();
    const ref = await fundRef(ctx, symbol);
    const filings = await nportFilings(ctx, ref);
    if (!filings.length) throw new SourceError(SEC, `no Form N-PORT filings found for ${symbol}`);
    return {
      blocks: [
        {
          kind: 'table',
          title: `${symbol} (CIK ${ref.cik}${ref.seriesId ? `, series ${ref.seriesId}` : ''})`,
          columns: [
            { key: 'filed', label: 'Filed' },
            { key: 'period', label: 'Period' },
            { key: 'accession', label: 'Accession' },
            { key: 'url', label: 'Portfolio XML', maxWidth: 86 },
          ],
          rows: filings.slice(0, 30).map((f) => ({ ...f })),
        },
      ],
      sourceUrl: filings[0].indexUrl,
      asOf: filings[0].filed,
      notes: ['Funds file N-PORT monthly; only the report for the last month of each fiscal quarter is public, 60 days after quarter end.'],
    };
  },
};

export interface Overlap {
  weight: number;
  common: { name: string; a: number; b: number }[];
  countA: number;
  countB: number;
}

/** Portfolio overlap = sum over shared positions of the smaller weight. Positions are matched by CUSIP, else by name. */
export function overlap(a: Holding[], b: Holding[]): Overlap {
  const id = (h: Holding): string => (h.cusip && !/^0+$|^N\/?A$/i.test(h.cusip) ? h.cusip : h.name.toLowerCase());
  const fold = (hs: Holding[]): Map<string, { name: string; w: number }> => {
    const m = new Map<string, { name: string; w: number }>();
    for (const h of hs) {
      if (!(h.pct !== null && h.pct > 0)) continue;
      const e = m.get(id(h)) ?? { name: h.name || h.title, w: 0 };
      e.w += h.pct;
      m.set(id(h), e);
    }
    return m;
  };
  const A = fold(a);
  const B = fold(b);
  const common: Overlap['common'] = [];
  for (const [k, x] of A) {
    const y = B.get(k);
    if (y) common.push({ name: x.name, a: x.w, b: y.w });
  }
  common.sort((p, q) => Math.min(q.a, q.b) - Math.min(p.a, p.b));
  return { weight: common.reduce((s, c) => s + Math.min(c.a, c.b), 0), common, countA: A.size, countB: B.size };
}

const overlapCard: CardDef = {
  id: 'equities.etf-overlap',
  title: 'Holdings overlap',
  source: SEC,
  description: 'How much two funds hold in common: overlap by weight, number of shared positions and the largest shared holdings.',
  params: [{ name: 'symbols', label: 'Two funds', default: 'SPY,QQQ', hint: 'two fund tickers, e.g. SPY,QQQ' }],
  async run(ctx, params) {
    const [sa, sb] = symbolList(params.symbols || 'SPY,QQQ');
    if (!sa || !sb) throw new SourceError(SEC, 'give two fund tickers, e.g. symbols=SPY,QQQ');
    const [a, b] = [await loadPortfolio(ctx, sa), await loadPortfolio(ctx, sb)];
    const o = overlap(a.portfolio.holdings, b.portfolio.holdings);
    return {
      blocks: [
        { kind: 'stats', items: [
          { label: 'Overlap by weight', value: o.weight, format: 'pct', digits: 1 },
          { label: 'Shared positions', value: o.common.length, format: 'int' },
          { label: `${sa} positions`, value: o.countA, format: 'int' },
          { label: `${sb} positions`, value: o.countB, format: 'int' },
          { label: `${sa} report date`, value: a.portfolio.periodDate },
          { label: `${sb} report date`, value: b.portfolio.periodDate },
        ] },
        {
          kind: 'table',
          title: 'Largest shared holdings',
          columns: [
            { key: 'name', label: 'Holding', maxWidth: 40 },
            { key: 'a', label: `${sa} weight`, format: 'pct' },
            { key: 'b', label: `${sb} weight`, format: 'pct' },
            { key: 'min', label: 'Overlap', format: 'pct' },
            { key: 'diff', label: `${sb} - ${sa}`, format: 'signedPct' },
          ],
          rows: o.common.slice(0, 30).map((c) => ({ name: c.name, a: c.a, b: c.b, min: Math.min(c.a, c.b), diff: c.b - c.a })),
        },
      ],
      sourceUrl: a.filing.indexUrl,
      asOf: a.portfolio.periodDate,
      notes: ['Overlap by weight is the sum, over positions both funds hold, of the smaller of the two weights (0% = nothing in common, 100% = identical portfolios). Positions are matched by CUSIP.', NPORT_NOTE, ...(a.portfolio.periodDate !== b.portfolio.periodDate ? ['The two reports are for different dates.'] : [])],
    };
  },
};

export const etfCards: CardDef[] = [profile, holdingsCard, sectorsCard, nportList, overlapCard];
