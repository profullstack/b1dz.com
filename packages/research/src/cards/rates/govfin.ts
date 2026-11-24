/** Government Finance: U.S. public debt, Treasury cash, auctions, the Fed balance sheet, primary dealers. */
import { num } from '../../http.js';
import { SourceError, type Block, type CardDef, type Ctx, type Row } from '../../types.js';
import { fred } from './fredx.js';
import { DAY, RANGE_CHOICES, bpDiff, dayMs, rangeStart, shiftBack, ymd } from './util.js';

const FISCAL = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service';
const rangeParam = (def: string, choices = RANGE_CHOICES) => ({ name: 'range', label: 'Range', default: def, choices });

type FiscalRow = Record<string, string>;

/** One Fiscal Data dataset query. `query` is the raw filter/sort/fields string. */
export async function fiscal(ctx: Ctx, path: string, query: string, ttl = 3600): Promise<FiscalRow[]> {
  const body = await ctx.http.json<{ data?: FiscalRow[] }>(`${FISCAL}/${path}?${query}`, { source: 'U.S. Treasury Fiscal Data', ttl, timeoutMs: 45_000 });
  if (!body.data?.length) throw new SourceError('U.S. Treasury Fiscal Data', `no rows for ${path.split('/').pop()}`);
  return body.data;
}

/** Fiscal Data prints missing numbers as the string "null". */
const n = (v: string | undefined): number | null => (v === undefined || v === 'null' ? null : num(v));
const size = (rows: number) => `page%5Bsize%5D=${rows}`;

// ---------- Public debt ----------

const debtToPenny: CardDef = {
  id: 'govfin.debt-to-penny',
  title: 'U.S. Debt to the Penny',
  source: 'U.S. Treasury Fiscal Data',
  description: 'Total public debt outstanding each business day, split into debt held by the public and intragovernmental holdings.',
  params: [rangeParam('5Y', [...RANGE_CHOICES, 'MAX'])],
  async run(ctx, p) {
    const start = rangeStart(p.range, ctx.now(), '1993-04-01');
    const rows = await fiscal(ctx, 'v2/accounting/od/debt_to_penny', `fields=record_date,debt_held_public_amt,intragov_hold_amt,tot_pub_debt_out_amt&filter=record_date:gte:${start}&sort=record_date&${size(10000)}`);
    const col = (k: string): [number, number][] => rows.flatMap((r): [number, number][] => (n(r[k]) === null ? [] : [[dayMs(r.record_date), n(r[k]) as number]]));
    const total = col('tot_pub_debt_out_amt');
    const last = rows[rows.length - 1];
    const lastT = total[total.length - 1];
    const back = (days: number) => {
      const target = lastT[0] - days * DAY;
      let hit: number | null = null;
      for (const [t, v] of total) if (t <= target) hit = v;
      return hit === null ? null : lastT[1] - hit;
    };
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Total public debt', value: n(last.tot_pub_debt_out_amt), format: 'usdCompact', digits: 3 },
            { label: 'Held by the public', value: n(last.debt_held_public_amt), format: 'usdCompact', digits: 3 },
            { label: 'Intragovernmental', value: n(last.intragov_hold_amt), format: 'usdCompact', digits: 3 },
            { label: 'Change, 30 days', value: back(30), format: 'usdCompact' },
            { label: 'Change, 1 year', value: back(365), format: 'usdCompact' },
          ],
        },
        {
          kind: 'chart',
          title: 'Debt outstanding',
          xType: 'time',
          series: [
            { name: 'Total', points: total },
            { name: 'Held by the public', points: col('debt_held_public_amt') },
            { name: 'Intragovernmental', points: col('intragov_hold_amt') },
          ],
          yFormat: 'usdCompact',
        },
      ],
      sourceUrl: 'https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/',
      asOf: last.record_date,
      notes: ['Intragovernmental holdings are Treasury securities owned by federal trust funds such as Social Security.'],
    };
  },
};

const debtByHolder: CardDef = {
  id: 'govfin.debt-by-holder',
  title: 'Public Debt by Security and Holder',
  source: 'U.S. Treasury Fiscal Data',
  description: 'Treasury securities outstanding by class (bills, notes, bonds, TIPS, FRNs, non-marketable), held by the public versus intragovernmental.',
  async run(ctx) {
    const rows = await fiscal(ctx, 'v1/debt/mspd/mspd_table_1', `sort=-record_date,src_line_nbr&${size(60)}`, 21_600);
    const date = rows[0].record_date;
    const latest = rows.filter((r) => r.record_date === date).sort((a, b) => Number(a.src_line_nbr) - Number(b.src_line_nbr));
    const grand = latest.map((r) => n(r.total_mil_amt) ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const out: Row[] = latest.map((r) => {
      const total = n(r.total_mil_amt);
      // Subtotal rows carry "_" as the class and the total's name as the type.
      const isTotal = r.security_class_desc === '_' || /^total/i.test(r.security_class_desc);
      return {
        security: isTotal ? (r.security_class_desc === '_' ? r.security_type_desc : r.security_class_desc) : `  ${r.security_class_desc}`,
        group: isTotal ? '' : r.security_type_desc,
        public: (n(r.debt_held_public_mil_amt) ?? 0) * 1e6,
        intragov: (n(r.intragov_hold_mil_amt) ?? 0) * 1e6,
        total: total === null ? null : total * 1e6,
        share: total !== null && grand ? (total / grand) * 100 : null,
      };
    });
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'security', label: 'Security class' },
            { key: 'group', label: 'Type' },
            { key: 'public', label: 'Held by public', format: 'usdCompact' },
            { key: 'intragov', label: 'Intragovernmental', format: 'usdCompact' },
            { key: 'total', label: 'Total', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct', digits: 1 },
          ],
          rows: out,
        },
      ],
      sourceUrl: 'https://fiscaldata.treasury.gov/datasets/monthly-statement-public-debt/',
      asOf: date,
      notes: ['From the Monthly Statement of the Public Debt, summary table. Share is of total public debt outstanding.'],
    };
  },
};

const avgInterestRates: CardDef = {
  id: 'govfin.avg-interest-rates',
  title: 'Average Interest Rate on Treasury Debt',
  source: 'U.S. Treasury Fiscal Data',
  description: 'The average interest rate the Treasury pays on each class of outstanding debt, monthly.',
  async run(ctx) {
    const today = ymd(ctx.now());
    const recent = await fiscal(ctx, 'v2/accounting/od/avg_interest_rates', `filter=record_date:gte:${shiftBack(today, '14M')}&sort=-record_date,src_line_nbr&${size(500)}`, 21_600);
    const date = recent[0].record_date;
    const yearAgoMonth = shiftBack(date, '1Y').slice(0, 7);
    const prior = new Map(recent.filter((r) => r.record_date.startsWith(yearAgoMonth)).map((r) => [r.security_desc, n(r.avg_interest_rate_amt)]));
    const rows: Row[] = recent
      .filter((r) => r.record_date === date)
      .map((r) => ({ security: r.security_desc, group: r.security_type_desc, rate: n(r.avg_interest_rate_amt), d1y: bpDiff(n(r.avg_interest_rate_amt), prior.get(r.security_desc)) }));
    const lines = ['Treasury Bills', 'Treasury Notes', 'Treasury Bonds', 'Total Interest-bearing Debt'];
    const hist = await fiscal(
      ctx,
      'v2/accounting/od/avg_interest_rates',
      `fields=record_date,security_desc,avg_interest_rate_amt&filter=record_date:gte:${shiftBack(today, '15Y')},security_desc:in:(${lines.map(encodeURIComponent).join(',')})&sort=record_date&${size(2000)}`,
      21_600,
    );
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Average interest rate by security',
          xType: 'time',
          series: lines
            .map((name) => ({ name, points: hist.filter((r) => r.security_desc === name).flatMap((r): [number, number][] => (n(r.avg_interest_rate_amt) === null ? [] : [[dayMs(r.record_date), n(r.avg_interest_rate_amt) as number]])) }))
            .filter((s) => s.points.length),
          yFormat: 'pct',
          yDigits: 2,
        },
        {
          kind: 'table',
          columns: [
            { key: 'security', label: 'Security' },
            { key: 'group', label: 'Type' },
            { key: 'rate', label: 'Avg rate', format: 'pct', digits: 3 },
            { key: 'd1y', label: '1Y chg', format: 'bp' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/',
      asOf: date,
      notes: ['The average coupon or discount on debt outstanding at month end: it moves slowly because only maturing debt reprices.'],
    };
  },
};

// ---------- Treasury cash ----------

const TGA_CLOSE = 'Treasury General Account (TGA) Closing Balance';

const tga: CardDef = {
  id: 'govfin.tga',
  title: 'Treasury General Account Balance',
  source: 'U.S. Treasury Fiscal Data',
  description: "The Treasury's operating cash balance at the Federal Reserve from the Daily Treasury Statement, with the day's deposits and withdrawals.",
  params: [rangeParam('1Y', ['1M', '3M', '6M', '1Y', '2Y'])],
  async run(ctx, p) {
    const start = rangeStart(p.range, ctx.now(), shiftBack(ymd(ctx.now()), '2Y'));
    const path = 'v1/accounting/dts/operating_cash_balance';
    const hist = await fiscal(ctx, path, `fields=record_date,open_today_bal&filter=record_date:gte:${start},account_type:eq:${encodeURIComponent(TGA_CLOSE)}&sort=record_date&${size(2000)}`);
    const points: [number, number][] = hist.flatMap((r): [number, number][] => (n(r.open_today_bal) === null ? [] : [[dayMs(r.record_date), (n(r.open_today_bal) as number) * 1e6]]));
    if (!points.length) throw new SourceError('U.S. Treasury Fiscal Data', 'no TGA closing balances in the range');
    const date = hist[hist.length - 1].record_date;
    const day = await fiscal(ctx, path, `filter=record_date:eq:${date}&sort=src_line_nbr&${size(20)}`);
    const find = (re: RegExp) => {
      const r = day.find((x) => re.test(x.account_type));
      return r && n(r.open_today_bal) !== null ? (n(r.open_today_bal) as number) * 1e6 : null;
    };
    const last = points[points.length - 1];
    const back = (days: number) => {
      let hit: number | null = null;
      for (const [t, v] of points) if (t <= last[0] - days * DAY) hit = v;
      return hit === null ? null : last[1] - hit;
    };
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Closing balance', value: last[1], format: 'usdCompact' },
            { label: 'Opening balance', value: find(/Opening Balance/i), format: 'usdCompact' },
            { label: 'Deposits', value: find(/Deposits/i), format: 'usdCompact' },
            { label: 'Withdrawals', value: find(/Withdrawals/i), format: 'usdCompact' },
            { label: 'Change, 1 week', value: back(7), format: 'usdCompact' },
            { label: 'Change, 1 month', value: back(30), format: 'usdCompact' },
          ],
        },
        { kind: 'chart', title: 'TGA closing balance', xType: 'time', series: [{ name: 'TGA', points }], yFormat: 'usdCompact' },
      ],
      sourceUrl: 'https://fiscaldata.treasury.gov/datasets/daily-treasury-statement/',
      asOf: date,
      notes: ['A rising TGA drains reserves from the banking system; a falling one adds them. Published one business day in arrears.'],
    };
  },
};

// ---------- Auctions ----------

const AUCTION_FIELDS =
  'auction_date,security_type,security_term,cusip,issue_date,maturity_date,offering_amt,bid_to_cover_ratio,high_yield,high_investment_rate,high_discnt_margin,int_rate,indirect_bidder_accepted,direct_bidder_accepted,primary_dealer_accepted,comp_accepted,reopening';

async function auctions(ctx: Ctx): Promise<FiscalRow[]> {
  return fiscal(ctx, 'v1/accounting/od/auctions_query', `fields=${AUCTION_FIELDS}&sort=-auction_date&${size(250)}`, 1800);
}

/** The stop-out rate of an auction: high yield (notes, bonds, TIPS), investment rate (bills) or discount margin (FRNs). */
export function auctionRate(r: FiscalRow): { rate: number | null; kind: string } {
  if (n(r.high_yield) !== null) return { rate: n(r.high_yield), kind: 'yield' };
  if (n(r.high_investment_rate) !== null) return { rate: n(r.high_investment_rate), kind: 'investment rate' };
  if (n(r.high_discnt_margin) !== null) return { rate: n(r.high_discnt_margin), kind: 'discount margin' };
  return { rate: null, kind: '' };
}

const share = (part: string | undefined, whole: string | undefined): number | null => {
  const a = n(part);
  const b = n(whole);
  return a === null || !b ? null : (a / b) * 100;
};

const auctionResults: CardDef = {
  id: 'govfin.auction-results',
  title: 'Treasury Auction Results',
  source: 'U.S. Treasury Fiscal Data',
  description: 'Recent Treasury auctions with the stop-out rate, bid-to-cover ratio and the share taken by indirect bidders, direct bidders and dealers.',
  async run(ctx) {
    const done = (await auctions(ctx)).filter((r) => n(r.bid_to_cover_ratio) !== null);
    if (!done.length) throw new SourceError('U.S. Treasury Fiscal Data', 'no completed auctions in the latest records');
    const rows: Row[] = done.slice(0, 40).map((r) => {
      const { rate, kind } = auctionRate(r);
      return {
        date: r.auction_date,
        security: `${r.security_term} ${r.security_type}${r.reopening === 'Yes' ? ' (reopen)' : ''}`,
        cusip: r.cusip,
        size: n(r.offering_amt),
        rate,
        kind,
        btc: n(r.bid_to_cover_ratio),
        indirect: share(r.indirect_bidder_accepted, r.comp_accepted),
        direct: share(r.direct_bidder_accepted, r.comp_accepted),
        dealer: share(r.primary_dealer_accepted, r.comp_accepted),
      };
    });
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'date', label: 'Auction', format: 'date' },
            { key: 'security', label: 'Security' },
            { key: 'cusip', label: 'CUSIP' },
            { key: 'size', label: 'Offered', format: 'usdCompact', digits: 0 },
            { key: 'rate', label: 'High rate', format: 'pct', digits: 3 },
            { key: 'kind', label: 'Rate is' },
            { key: 'btc', label: 'Bid/cover', format: 'num', digits: 2 },
            { key: 'indirect', label: 'Indirect', format: 'pct', digits: 1 },
            { key: 'direct', label: 'Direct', format: 'pct', digits: 1 },
            { key: 'dealer', label: 'Dealers', format: 'pct', digits: 1 },
          ],
          rows,
          footnote: 'Bidder shares are of the competitive amount accepted. Indirect bidders include foreign central banks; a high dealer share means weaker end-investor demand.',
        },
      ],
      sourceUrl: 'https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/',
      asOf: String(rows[0].date),
    };
  },
};

const auctionsPending: CardDef = {
  id: 'govfin.auctions-upcoming',
  title: 'Announced Treasury Auctions',
  source: 'U.S. Treasury Fiscal Data',
  description: 'Treasury auctions that have been announced and have no results yet: security, auction and issue dates, offering size.',
  async run(ctx) {
    const today = ymd(ctx.now());
    const pending = (await auctions(ctx)).filter((r) => n(r.bid_to_cover_ratio) === null).sort((a, b) => a.auction_date.localeCompare(b.auction_date));
    if (!pending.length) throw new SourceError('U.S. Treasury Fiscal Data', 'no announced auctions awaiting results in the latest records');
    const future = pending.filter((r) => r.auction_date >= today);
    const shown = future.length ? future : pending.slice(-20);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'date', label: 'Auction', format: 'date' },
            { key: 'security', label: 'Security' },
            { key: 'cusip', label: 'CUSIP' },
            { key: 'size', label: 'Offering', format: 'usdCompact', digits: 0 },
            { key: 'issue', label: 'Issue', format: 'date' },
            { key: 'maturity', label: 'Maturity', format: 'date' },
            { key: 'coupon', label: 'Coupon', format: 'pct', digits: 3 },
          ],
          rows: shown.map((r) => ({
            date: r.auction_date,
            security: `${r.security_term} ${r.security_type}${r.reopening === 'Yes' ? ' (reopen)' : ''}`,
            cusip: r.cusip,
            size: n(r.offering_amt),
            issue: r.issue_date,
            maturity: r.maturity_date,
            coupon: n(r.int_rate),
          })),
        },
      ],
      sourceUrl: 'https://www.treasurydirect.gov/auctions/upcoming/',
      asOf: shown[shown.length - 1].auction_date,
      notes: future.length
        ? []
        : [`Fiscal Data lists no auction dated after today: these are the most recent announced auctions whose results it has not published yet (latest ${shown[shown.length - 1].auction_date}).`],
    };
  },
};

// ---------- Fed balance sheet (H.4.1 via FRED) ----------

const H41: { id: string; name: string }[] = [
  { id: 'WALCL', name: 'Total assets' },
  { id: 'TREAST', name: 'Treasury securities held' },
  { id: 'WSHOMCB', name: 'Mortgage-backed securities held' },
  { id: 'WRESBAL', name: 'Reserve balances' },
];

/** Change over about a year in a [ms, value] series. */
function yearChange(points: [number, number][]): number | null {
  const last = points[points.length - 1];
  if (!last) return null;
  let hit: number | null = null;
  for (const [t, v] of points) if (t <= last[0] - 365 * DAY) hit = v;
  return hit === null ? null : last[1] - hit;
}

const fedBalanceSheet: CardDef = {
  id: 'govfin.fed-balance-sheet',
  title: 'Federal Reserve Balance Sheet (H.4.1)',
  source: 'FRED',
  description: 'Weekly Fed total assets, Treasury and mortgage-backed securities held outright, and bank reserve balances.',
  params: [rangeParam('5Y', [...RANGE_CHOICES, 'MAX'])],
  async run(ctx, p) {
    const start = rangeStart(p.range, ctx.now(), '2002-12-18');
    const fetchFrom = start < shiftBack(ymd(ctx.now()), '14M') ? start : shiftBack(ymd(ctx.now()), '14M');
    const lines: { name: string; points: [number, number][] }[] = [];
    const rows: Row[] = [];
    const missing: string[] = [];
    let source = 'FRED';
    let asOf = 0;
    let firstError: unknown;
    for (const s of H41) {
      try {
        const got = await fred(ctx, s.id, { start: fetchFrom, ttl: 3600 });
        const usd = got.points.map(([t, v]): [number, number] => [t, v * 1e6]);
        const last = usd[usd.length - 1];
        if (!last) throw new SourceError(got.source, `no observations for ${s.id}`);
        source = got.source;
        if (last[0] > asOf) asOf = last[0];
        const prev = usd[usd.length - 2];
        rows.push({ name: s.name, level: last[1], week: prev ? last[1] - prev[1] : null, year: yearChange(usd) });
        lines.push({ name: s.name, points: usd.filter(([t]) => t >= dayMs(start)) });
      } catch (e) {
        firstError ??= e;
        missing.push(s.name);
      }
    }
    if (!rows.length) throw firstError instanceof Error ? firstError : new SourceError('FRED', 'no H.4.1 series available');
    return {
      blocks: [
        { kind: 'chart', title: 'Fed balance sheet', xType: 'time', series: lines, yFormat: 'usdCompact' },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Item' },
            { key: 'level', label: 'Level', format: 'usdCompact', digits: 3 },
            { key: 'week', label: '1W chg', format: 'usdCompact' },
            { key: 'year', label: '1Y chg', format: 'usdCompact' },
          ],
          rows,
        },
      ],
      source,
      sourceUrl: 'https://www.federalreserve.gov/releases/h41/',
      asOf: asOf ? ymd(asOf) : undefined,
      notes: ['Wednesday levels from the Fed H.4.1 release, via FRED.', ...(missing.length ? [`Not available just now: ${missing.join(', ')}.`] : [])],
    };
  },
};

// ---------- Primary dealers ----------

const NYFED = 'https://markets.newyorkfed.org/api/pd';

interface PdPoint {
  asofdate: string;
  keyid: string;
  value: string;
}

const POSITIONS: [string, string][] = [
  ['PDPOSGST-TOT', 'U.S. Treasuries (ex TIPS)'],
  ['PDPOSFGS-TOT', 'Agency debt (ex MBS)'],
  ['PDPOSMBS-TOT', 'Agency and GSE MBS'],
  ['PDPOSCS-TOT', 'Corporate securities'],
  ['PDPOSABS-TOT', 'Asset-backed securities'],
  ['PDPOSSMGO-TOT', 'State and municipal'],
];

const FAILS: [string, string][] = [
  ['USTET', 'U.S. Treasuries (ex TIPS)'],
  ['UST', 'TIPS'],
  ['FGEM', 'Agency debt (ex MBS)'],
  ['FGM', 'Agency and GSE MBS'],
  ['OM', 'Other MBS'],
  ['CS', 'Corporate securities'],
];

async function pdLatest(ctx: Ctx): Promise<{ date: string; values: Map<string, number | null> }> {
  const body = await ctx.http.json<{ pd?: { timeseries?: PdPoint[] } }>(`${NYFED}/latest/SBN2024.json`, { source: 'New York Fed', ttl: 3600, timeoutMs: 30_000 });
  const list = body.pd?.timeseries ?? [];
  if (!list.length) throw new SourceError('New York Fed', 'no primary dealer statistics in the response');
  return { date: list[0].asofdate, values: new Map(list.map((x) => [x.keyid, num(x.value)])) };
}

/** A primary dealer series ($ millions in the feed) as [ms, dollars]. "*" marks a suppressed value. */
export function pdSeries(list: PdPoint[], since: string): [number, number][] {
  return list.flatMap((x): [number, number][] => {
    const v = num(x.value);
    return v === null || x.asofdate < since ? [] : [[dayMs(x.asofdate), v * 1e6]];
  });
}

const primaryDealers: CardDef = {
  id: 'govfin.primary-dealers',
  title: 'Primary Dealer Positions and Settlement Fails',
  source: 'New York Fed',
  description: 'Weekly primary dealer net positions by asset class, and fails to deliver and receive, with the history of Treasury fails.',
  params: [rangeParam('5Y')],
  async run(ctx, p) {
    const { date, values } = await pdLatest(ctx);
    const usd = (k: string) => (values.get(k) == null ? null : (values.get(k) as number) * 1e6);
    const start = rangeStart(p.range, ctx.now(), '2013-04-03');
    const history = async (key: string) => {
      const body = await ctx.http.json<{ pd?: { timeseries?: PdPoint[] } }>(`${NYFED}/get/${key}.json`, { source: 'New York Fed', ttl: 21_600, timeoutMs: 30_000 });
      return pdSeries(body.pd?.timeseries ?? [], start);
    };
    const ftd = await history('PDFTD-USTET');
    const ftr = await history('PDFTR-USTET');
    const blocks: Block[] = [
      {
        kind: 'table',
        title: 'Net positions (long minus short)',
        columns: [
          { key: 'name', label: 'Asset class' },
          { key: 'net', label: 'Net position', format: 'usdCompact' },
        ],
        rows: POSITIONS.map(([k, name]) => ({ name, net: usd(k) })).filter((r) => r.net !== null),
      },
      {
        kind: 'table',
        title: 'Settlement fails, weekly cumulative',
        columns: [
          { key: 'name', label: 'Asset class' },
          { key: 'ftd', label: 'Fails to deliver', format: 'usdCompact' },
          { key: 'ftdChg', label: '1W chg', format: 'usdCompact' },
          { key: 'ftr', label: 'Fails to receive', format: 'usdCompact' },
          { key: 'ftrChg', label: '1W chg', format: 'usdCompact' },
        ],
        rows: FAILS.map(([k, name]) => ({ name, ftd: usd(`PDFTD-${k}`), ftdChg: usd(`PDFTD-${k}C`), ftr: usd(`PDFTR-${k}`), ftrChg: usd(`PDFTR-${k}C`) })).filter((r) => r.ftd !== null || r.ftr !== null),
      },
      {
        kind: 'chart',
        title: 'Treasury fails (ex TIPS)',
        xType: 'time',
        series: [
          { name: 'Fails to deliver', points: ftd },
          { name: 'Fails to receive', points: ftr },
        ].filter((s) => s.points.length),
        yFormat: 'usdCompact',
      },
    ];
    return {
      blocks,
      sourceUrl: 'https://www.newyorkfed.org/markets/counterparties/primary-dealers-statistics',
      asOf: date,
      notes: ['Reported by the primary dealers for the week ending Wednesday, published about a week later. Fails are summed over the days of the week, so one position failing for five days counts five times.'],
    };
  },
};

export const govfinCards: CardDef[] = [debtToPenny, debtByHolder, avgInterestRates, tga, auctionResults, auctionsPending, fedBalanceSheet, primaryDealers];
