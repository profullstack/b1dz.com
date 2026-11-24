/** Money & Banking: bank credit quality, FDIC failures, single-bank lookup, Fed and ECB liquidity. */
import { SourceError, type Block, type CardDef, type Ctx, type Row } from '../../types.js';
import { fred, fredLines } from './fredx.js';
import { DAY, RANGE_CHOICES, dayMs, ecbCsv, ecbPeriodDate, median, percentileRank, rangeStart, sdmxSeries, shiftBack, ymd } from './util.js';

const FDIC = 'https://banks.data.fdic.gov/api';
const rangeParam = (def: string) => ({ name: 'range', label: 'Range', default: def, choices: [...RANGE_CHOICES, 'MAX'] });

interface FdicBody<T> {
  meta?: { total?: number };
  data?: { data: T }[];
}

async function fdic<T>(ctx: Ctx, path: string, query: Record<string, string>, ttl = 21_600): Promise<{ rows: T[]; total: number }> {
  const qs = Object.entries(query)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const body = await ctx.http.json<FdicBody<T>>(`${FDIC}/${path}?${qs}`, { source: 'FDIC', ttl, timeoutMs: 45_000 });
  return { rows: (body.data ?? []).map((d) => d.data), total: body.meta?.total ?? 0 };
}

// ---------- Credit quality (Fed charge-off and delinquency rates via FRED) ----------

const LOAN_TYPES: { name: string; delinquency: string; chargeOff: string }[] = [
  { name: 'All loans and leases', delinquency: 'DRALACBS', chargeOff: 'CORALACBS' },
  { name: 'Credit cards', delinquency: 'DRCCLACBS', chargeOff: 'CORCCACBS' },
  { name: 'Consumer loans', delinquency: 'DRCLACBS', chargeOff: 'CORCACBS' },
  { name: 'Business (C&I) loans', delinquency: 'DRBLACBS', chargeOff: 'CORBLACBS' },
  { name: 'Commercial real estate', delinquency: 'DRCRELEXFACBS', chargeOff: 'CORCREXFACBS' },
  { name: 'Residential mortgages', delinquency: 'DRSFRMACBS', chargeOff: 'CORSFRMACBS' },
];

const creditQuality: CardDef = {
  id: 'banking.credit-quality',
  title: 'Bank Loan Delinquency and Charge-off Rates',
  source: 'FRED',
  description: 'Delinquency and net charge-off rates at U.S. commercial banks by loan type, quarterly.',
  async run(ctx) {
    const start = shiftBack(ymd(ctx.now()), '20Y');
    const dq = await fredLines(ctx, LOAN_TYPES.map((t) => ({ id: t.delinquency, name: t.name })), { start, ttl: 21_600 });
    const co = await fredLines(ctx, LOAN_TYPES.map((t) => ({ id: t.chargeOff, name: t.name })), { start, ttl: 21_600 });
    const last = (lines: typeof dq.lines, name: string, back = 0) => {
      const pts = lines.find((l) => l.name === name)?.points ?? [];
      return pts[pts.length - 1 - back];
    };
    let asOf = 0;
    const rows: Row[] = LOAN_TYPES.map((t) => {
      const d = last(dq.lines, t.name);
      const d4 = last(dq.lines, t.name, 4);
      const c = last(co.lines, t.name);
      const c4 = last(co.lines, t.name, 4);
      if (d && d[0] > asOf) asOf = d[0];
      return {
        name: t.name,
        delinquency: d?.[1],
        dChg: d && d4 ? Math.round((d[1] - d4[1]) * 100) : null,
        chargeOff: c?.[1],
        cChg: c && c4 ? Math.round((c[1] - c4[1]) * 100) : null,
      };
    });
    const missing = [...new Set([...dq.missing, ...co.missing])];
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Loan type' },
            { key: 'delinquency', label: 'Delinquent', format: 'pct', digits: 2 },
            { key: 'dChg', label: '1Y chg', format: 'bp' },
            { key: 'chargeOff', label: 'Net charge-offs', format: 'pct', digits: 2 },
            { key: 'cChg', label: '1Y chg', format: 'bp' },
          ],
          rows,
        },
        { kind: 'chart', title: 'Delinquency rate', xType: 'time', series: dq.lines, yFormat: 'pct', yDigits: 1 },
        { kind: 'chart', title: 'Net charge-off rate (annualised)', xType: 'time', series: co.lines, yFormat: 'pct', yDigits: 1 },
      ],
      source: dq.source,
      sourceUrl: 'https://www.federalreserve.gov/releases/chargeoff/',
      asOf: asOf ? ymd(asOf) : undefined,
      notes: [
        'Federal Reserve series for all commercial banks, seasonally adjusted, via FRED. Delinquent = 30 days or more past due or on non-accrual, as a share of loans.',
        ...(missing.length ? [`Not available just now: ${missing.join(', ')}.`] : []),
      ],
    };
  },
};

// ---------- FDIC failures ----------

interface Failure {
  NAME: string;
  CERT: number;
  FAILDATE: string;
  FAILYR: string;
  CITYST: string;
  QBFASSET: number | null;
  QBFDEP: number | null;
  COST: number | null;
  RESTYPE1: string;
}

/** FDIC dates come as M/D/YYYY. */
export function fdicDate(s: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s;
}

const RESOLUTION: Record<string, string> = {
  PA: 'Purchase and assumption',
  PI: 'P&A, insured deposits only',
  PO: 'Payout',
  IDT: 'Insured deposit transfer',
  'A/A': 'Assisted merger',
  MGR: 'Management consignment',
  REP: 'Reprivatisation',
};

const failures: CardDef = {
  id: 'banking.failures',
  title: 'FDIC Bank Failures',
  source: 'FDIC',
  description: 'The most recent U.S. bank failures with assets, deposits and the estimated loss to the insurance fund, and failures per year since 2000.',
  async run(ctx) {
    const { rows, total } = await fdic<Failure>(ctx, 'failures', { fields: 'NAME,CERT,FAILDATE,FAILYR,CITYST,QBFASSET,QBFDEP,COST,RESTYPE1', sort_by: 'FAILDATE', sort_order: 'DESC', limit: '10000' });
    if (!rows.length) throw new SourceError('FDIC', 'no failures returned');
    const list = rows.map((r) => ({ ...r, date: fdicDate(r.FAILDATE) })).sort((a, b) => b.date.localeCompare(a.date));
    const thisYear = ctx.now().getUTCFullYear();
    const years: number[] = [];
    for (let y = 2000; y <= thisYear; y++) years.push(y);
    const count = new Map<number, { n: number; assets: number }>();
    for (const r of list) {
      const y = Number(r.date.slice(0, 4));
      const c = count.get(y) ?? { n: 0, assets: 0 };
      c.n += 1;
      c.assets += (r.QBFASSET ?? 0) * 1000;
      count.set(y, c);
    }
    const blocks: Block[] = [
      {
        kind: 'stats',
        items: [
          { label: `Failures in ${thisYear}`, value: count.get(thisYear)?.n ?? 0, format: 'int' },
          { label: `Assets failed in ${thisYear}`, value: count.get(thisYear)?.assets ?? 0, format: 'usdCompact' },
          { label: `Failures in ${thisYear - 1}`, value: count.get(thisYear - 1)?.n ?? 0, format: 'int' },
          { label: 'Failures since 1934', value: total || list.length, format: 'int' },
        ],
      },
      {
        kind: 'table',
        title: 'Most recent failures',
        columns: [
          { key: 'date', label: 'Closed', format: 'date' },
          { key: 'name', label: 'Bank', maxWidth: 40 },
          { key: 'where', label: 'City' },
          { key: 'cert', label: 'Cert' },
          { key: 'assets', label: 'Assets', format: 'usdCompact' },
          { key: 'deposits', label: 'Deposits', format: 'usdCompact' },
          { key: 'cost', label: 'Est. loss', format: 'usdCompact' },
          { key: 'how', label: 'Resolution' },
        ],
        rows: list.slice(0, 30).map((r) => ({
          date: r.date,
          name: r.NAME,
          where: r.CITYST,
          cert: String(r.CERT),
          assets: r.QBFASSET == null ? null : r.QBFASSET * 1000,
          deposits: r.QBFDEP == null ? null : r.QBFDEP * 1000,
          cost: r.COST == null ? null : r.COST * 1000,
          how: RESOLUTION[r.RESTYPE1] ?? r.RESTYPE1,
        })),
      },
      {
        kind: 'chart',
        title: 'Failures per year',
        xType: 'category',
        style: 'bar',
        categories: years.map(String),
        series: [{ name: 'Banks failed', points: years.map((y, i): [number, number] => [i, count.get(y)?.n ?? 0]) }],
        yFormat: 'int',
      },
    ];
    return {
      blocks,
      sourceUrl: 'https://www.fdic.gov/bank-failures/failed-bank-list',
      asOf: list[0].date,
      notes: ['Assets and deposits are as of the last quarterly report before failure; the loss is the FDIC estimate to the Deposit Insurance Fund and is revised over time.'],
    };
  },
};

// ---------- Single-bank lookup ----------

interface Institution {
  NAME: string;
  CERT: number;
  ASSET: number;
  CITY: string;
  STALP: string;
  ACTIVE?: number;
}

type Financials = Record<string, number | string | null>;

const RATIOS: { key: string; label: string; digits: number }[] = [
  { key: 'ROA', label: 'Return on assets', digits: 2 },
  { key: 'ROE', label: 'Return on equity', digits: 2 },
  { key: 'NIMY', label: 'Net interest margin', digits: 2 },
  { key: 'EEFFR', label: 'Efficiency ratio (cost / revenue)', digits: 1 },
  { key: 'EQV', label: 'Equity / assets', digits: 2 },
  { key: 'RBC1AAJ', label: 'Tier 1 leverage ratio', digits: 2 },
  { key: 'IDT1CER', label: 'Common equity tier 1 ratio', digits: 2 },
  { key: 'LNLSDEPR', label: 'Loans / deposits', digits: 1 },
  { key: 'NCLNLSR', label: 'Noncurrent loans / loans', digits: 2 },
  { key: 'NTLNLSR', label: 'Net charge-offs / loans', digits: 2 },
  { key: 'LNATRESR', label: 'Loss allowance / loans', digits: 2 },
];

/** Asset-size peer groups, in $ thousands as the FDIC reports them. */
export const PEER_GROUPS: { label: string; lo: number; hi: number | null }[] = [
  { label: 'under $100M', lo: 0, hi: 100_000 },
  { label: '$100M to $1B', lo: 100_000, hi: 1_000_000 },
  { label: '$1B to $10B', lo: 1_000_000, hi: 10_000_000 },
  { label: '$10B to $250B', lo: 10_000_000, hi: 250_000_000 },
  { label: 'over $250B', lo: 250_000_000, hi: null },
];

export function peerGroup(assetThousands: number): (typeof PEER_GROUPS)[number] {
  return PEER_GROUPS.find((g) => assetThousands >= g.lo && (g.hi === null || assetThousands < g.hi)) ?? PEER_GROUPS[PEER_GROUPS.length - 1];
}

/** A bank's ratios against its peers: peer median and the share of peers at or below the bank. */
export function peerTable(bank: Financials, peers: Financials[]): Row[] {
  return RATIOS.map((r) => {
    const mine = typeof bank[r.key] === 'number' ? (bank[r.key] as number) : null;
    const values = peers.map((p) => p[r.key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return { ratio: r.label, bank: mine, median: median(values), pctile: mine === null ? null : percentileRank(values, mine), peers: values.length };
  });
}

async function findBank(ctx: Ctx, query: string): Promise<{ bank: Institution; others: Institution[] }> {
  const q = query.trim();
  const fields = 'NAME,CERT,ASSET,CITY,STALP,ACTIVE';
  if (/^\d+$/.test(q)) {
    const { rows } = await fdic<Institution>(ctx, 'institutions', { filters: `CERT:${q}`, fields, limit: '1' });
    if (!rows.length) throw new SourceError('FDIC', `no institution with FDIC certificate ${q}`);
    return { bank: rows[0], others: [] };
  }
  const { rows } = await fdic<Institution>(ctx, 'institutions', { search: `NAME:"${q.replace(/"/g, '')}"`, filters: 'ACTIVE:1', fields, sort_by: 'ASSET', sort_order: 'DESC', limit: '6' });
  if (!rows.length) throw new SourceError('FDIC', `no active FDIC-insured bank matches "${q}"`);
  return { bank: rows[0], others: rows.slice(1) };
}

const bankLookup: CardDef = {
  id: 'banking.bank-lookup',
  title: 'Bank Lookup: Key Ratios vs Peers',
  source: 'FDIC',
  description: "One bank's profitability, capital and asset-quality ratios from its latest call report, ranked against banks of similar size.",
  params: [{ name: 'query', label: 'Bank', default: 'JPMorgan Chase Bank', hint: 'bank name or FDIC certificate number' }],
  async run(ctx, p) {
    const { bank, others } = await findBank(ctx, p.query ?? 'JPMorgan Chase Bank');
    const fields = ['CERT', 'REPDTE', 'ASSET', 'DEP', 'NETINC', ...RATIOS.map((r) => r.key)].join(',');
    const own = (await fdic<Financials>(ctx, 'financials', { filters: `CERT:${bank.CERT}`, fields, sort_by: 'REPDTE', sort_order: 'DESC', limit: '40' })).rows;
    if (!own.length) throw new SourceError('FDIC', `no financial reports for ${bank.NAME}`);
    const latest = own[0];
    const repdte = String(latest.REPDTE);
    const date = `${repdte.slice(0, 4)}-${repdte.slice(4, 6)}-${repdte.slice(6, 8)}`;
    const assets = Number(latest.ASSET ?? bank.ASSET);
    const group = peerGroup(assets);
    const peers = (
      await fdic<Financials>(ctx, 'financials', { filters: `REPDTE:${repdte} AND ASSET:[${group.lo} TO ${group.hi === null ? '*' : group.hi}]`, fields: ['CERT', ...RATIOS.map((r) => r.key)].join(','), limit: '10000' })
    ).rows;
    const rows = peerTable(latest, peers);
    const history = (key: string): [number, number][] =>
      own
        .flatMap((f): [number, number][] => {
          const d = String(f.REPDTE);
          const v = f[key];
          return typeof v === 'number' ? [[dayMs(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`), v]] : [];
        })
        .reverse();
    const money = (v: number | string | null | undefined) => (typeof v === 'number' ? v * 1000 : null);
    return {
      blocks: [
        {
          kind: 'stats',
          title: `${bank.NAME} (${bank.CITY}, ${bank.STALP}; cert ${bank.CERT})`,
          items: [
            { label: 'Total assets', value: money(latest.ASSET), format: 'usdCompact' },
            { label: 'Deposits', value: money(latest.DEP), format: 'usdCompact' },
            { label: 'Net income, year to date', value: money(latest.NETINC), format: 'usdCompact' },
            { label: 'Peer group', value: `${group.label} (${peers.length} banks)` },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'ratio', label: 'Ratio' },
            { key: 'bank', label: 'Bank', format: 'pct', digits: 2 },
            { key: 'median', label: 'Peer median', format: 'pct', digits: 2 },
            { key: 'pctile', label: 'Percentile', format: 'pct', digits: 0 },
            { key: 'peers', label: 'Peers', format: 'int' },
          ],
          rows,
          footnote: 'Percentile = share of peer banks with a value at or below this bank. High is good for returns and capital, bad for the efficiency ratio, noncurrent loans and charge-offs.',
        },
        {
          kind: 'chart',
          title: 'Return on assets and net interest margin, last ten years',
          xType: 'time',
          series: [
            { name: 'ROA', points: history('ROA') },
            { name: 'Net interest margin', points: history('NIMY') },
          ].filter((s) => s.points.length),
          yFormat: 'pct',
          yDigits: 2,
        },
      ],
      sourceUrl: `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${bank.CERT}`,
      asOf: date,
      notes: [
        `Call report of ${date}. Income ratios are annualised year to date. Peers are all FDIC-insured institutions reporting that quarter with assets ${group.label}; percentiles are computed here.`,
        ...(others.length ? [`Other matches: ${others.map((o) => `${o.NAME} (cert ${o.CERT})`).join('; ')}.`] : []),
      ],
    };
  },
};

// ---------- Liquidity ----------

const fedLiquidity: CardDef = {
  id: 'banking.fed-liquidity',
  title: 'Fed Liquidity: Reserves, ON RRP and the TGA',
  source: 'FRED',
  description: 'Bank reserve balances at the Fed, overnight reverse repo usage and the Treasury General Account.',
  params: [rangeParam('5Y')],
  async run(ctx, p) {
    const start = rangeStart(p.range, ctx.now(), '2003-01-01');
    const fetchFrom = start < shiftBack(ymd(ctx.now()), '14M') ? start : shiftBack(ymd(ctx.now()), '14M');
    const list = [
      { id: 'WRESBAL', name: 'Reserve balances', scale: 1e6 },
      { id: 'RRPONTSYD', name: 'Overnight reverse repo', scale: 1e9 },
      { id: 'WTREGEN', name: 'Treasury General Account', scale: 1e6 },
    ];
    const lines: { name: string; points: [number, number][] }[] = [];
    const rows: Row[] = [];
    const missing: string[] = [];
    let source = 'FRED';
    let asOf = 0;
    let firstError: unknown;
    for (const s of list) {
      try {
        const got = await fred(ctx, s.id, { start: fetchFrom, ttl: 3600 });
        const usd = got.points.map(([t, v]): [number, number] => [t, v * s.scale]);
        const last = usd[usd.length - 1];
        if (!last) throw new SourceError(got.source, `no observations for ${s.id}`);
        source = got.source;
        if (last[0] > asOf) asOf = last[0];
        const at = (days: number) => {
          let hit: number | null = null;
          for (const [t, v] of usd) if (t <= last[0] - days * DAY) hit = v;
          return hit === null ? null : last[1] - hit;
        };
        rows.push({ name: s.name, date: ymd(last[0]), level: last[1], month: at(30), year: at(365) });
        lines.push({ name: s.name, points: usd.filter(([t]) => t >= dayMs(start)) });
      } catch (e) {
        firstError ??= e;
        missing.push(s.name);
      }
    }
    if (!rows.length) throw firstError instanceof Error ? firstError : new SourceError('FRED', 'no liquidity series available');
    return {
      blocks: [
        { kind: 'chart', title: 'Fed liabilities that hold the system\'s cash', xType: 'time', series: lines, yFormat: 'usdCompact' },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Item' },
            { key: 'date', label: 'Date', format: 'date' },
            { key: 'level', label: 'Level', format: 'usdCompact', digits: 3 },
            { key: 'month', label: '1M chg', format: 'usdCompact' },
            { key: 'year', label: '1Y chg', format: 'usdCompact' },
          ],
          rows,
        },
      ],
      source,
      sourceUrl: 'https://www.federalreserve.gov/releases/h41/',
      asOf: asOf ? ymd(asOf) : undefined,
      notes: [
        'Reserves and the TGA are weekly Wednesday levels (H.4.1); reverse repo is daily. Cash moves between the three: a falling RRP or TGA adds reserves.',
        ...(missing.length ? [`Not available just now: ${missing.join(', ')}.`] : []),
      ],
    };
  },
};

const ILM: [string, string][] = [
  ['T000000', 'Total assets'],
  ['A070100', 'Securities held for monetary policy'],
  ['L020200', 'Deposit facility'],
  ['L020100', 'Current accounts (incl. minimum reserves)'],
];

const ecbLiquidity: CardDef = {
  id: 'banking.ecb-liquidity',
  title: 'Eurosystem Balance Sheet and Bank Liquidity',
  source: 'ECB',
  description: 'Eurosystem total assets, monetary policy securities and the cash banks hold at the central bank (deposit facility and current accounts), weekly.',
  params: [rangeParam('5Y')],
  async run(ctx, p) {
    const start = rangeStart(p.range, ctx.now(), '1999-01-01');
    const text = await ecbCsv(ctx, 'ILM', `W.U2.C.${ILM.map((x) => x[0]).join('+')}.Z5+U2.Z01+EUR`, `startPeriod=${start}`);
    const got = sdmxSeries(text, 'BS_ITEM');
    const series = ILM.map(([code, name]) => ({
      code,
      name,
      points: (got.get(code) ?? []).map(([period, v]): [number, number] => [dayMs(ecbPeriodDate(period)), v * 1e6]).sort((a, b) => a[0] - b[0]),
    })).filter((s) => s.points.length);
    if (!series.length) throw new SourceError('ECB', 'no Eurosystem weekly financial statement observations');
    const by = (code: string) => series.find((s) => s.code === code)?.points ?? [];
    const df = new Map(by('L020200'));
    const bankCash: [number, number][] = by('L020100').flatMap(([t, v]): [number, number][] => (df.has(t) ? [[t, v + (df.get(t) as number)]] : []));
    const lastOf = (pts: [number, number][]) => pts[pts.length - 1];
    const yearChg = (pts: [number, number][]) => {
      const last = lastOf(pts);
      if (!last) return null;
      let hit: number | null = null;
      for (const [t, v] of pts) if (t <= last[0] - 365 * DAY) hit = v;
      return hit === null ? null : last[1] - hit;
    };
    const rows: Row[] = [...series.map((s) => ({ name: s.name, level: lastOf(s.points)?.[1], year: yearChg(s.points) })), { name: 'Bank cash at the Eurosystem (deposit facility + current accounts)', level: lastOf(bankCash)?.[1], year: yearChg(bankCash) }];
    const asOf = lastOf(series[0].points)?.[0];
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Eurosystem weekly financial statement (EUR)',
          xType: 'time',
          series: [...series.filter((s) => s.code !== 'L020100' && s.code !== 'L020200').map((s) => ({ name: s.name, points: s.points })), { name: 'Deposit facility + current accounts', points: bankCash }],
          yFormat: 'compact',
        },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Item' },
            { key: 'level', label: 'EUR', format: 'compact', digits: 3 },
            { key: 'year', label: '1Y chg', format: 'compact' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://www.ecb.europa.eu/press/pr/wfs/html/index.en.html',
      asOf: asOf ? ymd(asOf) : undefined,
      notes: [
        'From the Eurosystem weekly financial statement, dated to the Friday of the reporting week. Excess liquidity is roughly the deposit facility plus current accounts, less the minimum reserve requirement (not netted out here).',
      ],
    };
  },
};

export const bankingCards: CardDef[] = [creditQuality, failures, bankLookup, fedLiquidity, ecbLiquidity];
