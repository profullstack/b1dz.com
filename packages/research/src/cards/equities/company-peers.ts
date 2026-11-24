/** Company > Price & Peers (comparable companies, risk) and Growth & Ratios (valuation multiple history). */
import { pctChange } from '../../format.js';
import { num } from '../../http.js';
import { getHistory, mapLimit } from '../../lib/market.js';
import { NASDAQ, nasdaqGet, nasdaqSymbol } from '../../lib/nasdaq.js';
import { cikFor, companyFacts, SEC } from '../../lib/sec.js';
import { SourceError, type CardDef, type Column, type Ctx, type Row } from '../../types.js';
import { financials, type Financials } from './company-financials.js';
import { pickPeers, universe } from './universe.js';
import { align, annualVol, beta, correlation, dailyReturns, maxDrawdown, median, pct, percentile, rowOf, safeDiv, SYMBOL, symbolList, symbolOf, totalReturn } from './util.js';
import { fundamentals, monthEnds, multiplesAt } from './xbrl.js';

const PEERS = { name: 'symbols', label: 'Peers', default: '', hint: 'comma list to override the automatic peers, e.g. MSFT,GOOGL,DELL' };

/** The company first, then the peers given, or the automatic ones. */
async function peerSet(ctx: Ctx, symbol: string, given: string | undefined): Promise<{ symbols: string[]; auto: boolean }> {
  const manual = symbolList(given).filter((s) => s !== symbol);
  if (manual.length) return { symbols: [symbol, ...manual.slice(0, 11)], auto: false };
  const peers = pickPeers(await universe(ctx), symbol, 6);
  return { symbols: [symbol, ...peers.map((p) => p.replace(/\./g, '-'))], auto: true };
}

export interface CompRow {
  symbol: string;
  marketCap: number | null;
  ev: number | null;
  pe: number | null;
  ps: number | null;
  pb: number | null;
  evSales: number | null;
  grossMargin: number | null;
  opMargin: number | null;
  netMargin: number | null;
  growth: number | null;
  roe: number | null;
  debtEquity: number | null;
  fy: string;
}

/** Multiples and ratios from the latest fiscal year of the standardised statements. */
export function compRow(symbol: string, marketCap: number | null, f: Financials): CompRow {
  const at = (row: (number | null)[]): number | null => row[0] ?? null;
  const rev = rowOf(f.income, 'Total Revenue');
  const ni = at(rowOf(f.income, 'Net Income'));
  const equity = at(rowOf(f.balance, 'Total Equity'));
  const debtRows = [at(rowOf(f.balance, /^Short-Term Debt/i)), at(rowOf(f.balance, 'Long-Term Debt'))];
  const debt = debtRows.every((d) => d === null) ? null : (debtRows[0] ?? 0) + (debtRows[1] ?? 0);
  const cash = (at(rowOf(f.balance, 'Cash and Cash Equivalents')) ?? 0) + (at(rowOf(f.balance, 'Short-Term Investments')) ?? 0);
  // Enterprise value is not defined for banks and insurers (unclassified balance sheet: deposits and float are not debt, cash is inventory).
  const financial = at(rowOf(f.balance, 'Total Current Assets')) === null;
  const ev = marketCap !== null && debt !== null && !financial && marketCap + debt - cash > 0 ? marketCap + debt - cash : null;
  const positive = (v: number | null): number | null => (v !== null && v > 0 ? v : null);
  return {
    symbol,
    marketCap,
    ev,
    pe: safeDiv(marketCap, positive(ni)),
    ps: safeDiv(marketCap, positive(rev[0])),
    pb: safeDiv(marketCap, positive(equity)),
    evSales: safeDiv(ev, positive(rev[0])),
    grossMargin: at(rowOf(f.income, 'Cost of Revenue')) === null ? null : pct(at(rowOf(f.income, 'Gross Profit')), rev[0]),
    opMargin: pct(at(rowOf(f.income, 'Operating Income')), rev[0]),
    netMargin: pct(ni, rev[0]),
    growth: pctChange(rev[0], rev[1]),
    roe: pct(ni, positive(equity)),
    debtEquity: financial ? null : safeDiv(debt, positive(equity)),
    fy: f.income.periods[0] ?? '',
  };
}

const COMP_KEYS: (keyof CompRow)[] = ['marketCap', 'ev', 'pe', 'ps', 'pb', 'evSales', 'grossMargin', 'opMargin', 'netMargin', 'growth', 'roe', 'debtEquity'];

export function medianRow(rows: CompRow[]): Row {
  const out: Row = { symbol: 'Peer median' };
  for (const k of COMP_KEYS) out[k] = median(rows.map((r) => r[k] as number | null));
  return out;
}

const comps: CardDef = {
  id: 'equities.comps',
  title: 'Comparable companies',
  source: NASDAQ,
  description: 'Market value, enterprise value, P/E, P/S, P/B, margins, growth, ROE and leverage for the company and its peers, with a peer median.',
  params: [SYMBOL, PEERS],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const { symbols, auto } = await peerSet(ctx, symbol, params.symbols);
    const failed: string[] = [];
    const got = await mapLimit(symbols, 3, async (s) => {
      try {
        const [summary, f] = await Promise.all([
          nasdaqGet<{ summaryData?: Record<string, { value?: string } | undefined> }>(ctx, `/api/quote/${encodeURIComponent(nasdaqSymbol(s))}/summary?assetclass=stocks`, 900),
          financials(ctx, s),
        ]);
        return compRow(s, num(summary.summaryData?.MarketCap?.value) || null, f);
      } catch (e) {
        failed.push(`${s} (${(e as Error).message})`);
        return null;
      }
    });
    const rows = got.filter((r): r is CompRow => {
      if (r === null) return false;
      if (r.symbol !== symbol && r.ps === null && r.pe === null && r.pb === null) {
        failed.push(`${r.symbol} (no usable statements)`);
        return false;
      }
      return true;
    });
    if (!rows.length || rows[0].symbol !== symbol) throw new SourceError(NASDAQ, `no financial statements for ${symbol}`);
    const peers = rows.slice(1);
    const columns: Column[] = [
      { key: 'symbol', label: 'Company' },
      { key: 'marketCap', label: 'Mkt cap', format: 'usdCompact', digits: 1 },
      { key: 'ev', label: 'EV', format: 'usdCompact', digits: 1 },
      { key: 'pe', label: 'P/E', format: 'num', digits: 1 },
      { key: 'ps', label: 'P/S', format: 'num', digits: 1 },
      { key: 'pb', label: 'P/B', format: 'num', digits: 1 },
      { key: 'evSales', label: 'EV/Sales', format: 'num', digits: 1 },
      { key: 'grossMargin', label: 'Gross mgn', format: 'pct', digits: 1 },
      { key: 'opMargin', label: 'Op mgn', format: 'pct', digits: 1 },
      { key: 'netMargin', label: 'Net mgn', format: 'pct', digits: 1 },
      { key: 'growth', label: 'Rev growth', format: 'signedPct', digits: 1 },
      { key: 'roe', label: 'ROE', format: 'pct', digits: 1 },
      { key: 'debtEquity', label: 'Debt/Eq', format: 'num', digits: 2 },
      { key: 'fy', label: 'FY end' },
    ];
    const notes = [
      `${auto ? 'Peers chosen automatically: same Nasdaq industry (or sector), nearest in market value.' : 'Peers as given.'} Set "symbols" to choose your own.`,
      'Multiples use the current market value over the latest full fiscal year (not trailing twelve months). EV = market value + debt - cash and short-term investments; leases, preferred stock and minority interests are not included. EV and debt/equity are blank for banks and insurers, where they are not meaningful. A multiple is blank when its denominator is not positive.',
    ];
    if (failed.length) notes.push(`Left out: ${failed.join('; ')}`);
    return {
      blocks: [{ kind: 'table', columns, rows: [...rows.map((r) => ({ ...r })), ...(peers.length ? [medianRow(peers)] : [])] }],
      sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${nasdaqSymbol(symbol).toLowerCase()}/financials`,
      asOf: rows[0].fy,
      notes,
    };
  },
};

const BENCH = '^GSPC';

const risk: CardDef = {
  id: 'equities.risk-peers',
  title: 'Risk versus peers',
  source: NASDAQ,
  description: 'One-year volatility, beta and correlation to the S&P 500, maximum drawdown and return for the company and its peers.',
  params: [SYMBOL, PEERS],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const { symbols, auto } = await peerSet(ctx, symbol, params.symbols);
    const bench = await getHistory(ctx, BENCH, '1Y');
    const benchRet = dailyReturns(bench.bars);
    const failed: string[] = [];
    const sources = new Set<string>([bench.source]);
    const got = await mapLimit(symbols, 4, async (s): Promise<Row | null> => {
      try {
        const h = await getHistory(ctx, s, '1Y');
        sources.add(h.source);
        const { x, y } = align(benchRet, dailyReturns(h.bars));
        return {
          symbol: s,
          vol: annualVol([...dailyReturns(h.bars).values()]),
          beta: beta(x, y),
          corr: correlation(x, y),
          mdd: maxDrawdown(h.bars),
          ret: totalReturn(h.bars),
          days: h.bars.length,
        };
      } catch (e) {
        failed.push(`${s} (${(e as Error).message})`);
        return null;
      }
    });
    const rows = got.filter((r): r is Row => r !== null);
    if (!rows.length) throw new SourceError(NASDAQ, `no price history for ${symbol}`);
    const peers = rows.slice(1);
    const med = (k: string): number | null => median(peers.map((r) => r[k] as number | null));
    const benchRow: Row = { symbol: 'S&P 500', vol: annualVol([...benchRet.values()]), beta: 1, corr: 1, mdd: maxDrawdown(bench.bars), ret: totalReturn(bench.bars), days: bench.bars.length };
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'symbol', label: 'Company' },
            { key: 'vol', label: 'Volatility', format: 'pct', digits: 1 },
            { key: 'beta', label: 'Beta', format: 'num', digits: 2 },
            { key: 'corr', label: 'Corr.', format: 'num', digits: 2 },
            { key: 'mdd', label: 'Max drawdown', format: 'signedPct', digits: 1 },
            { key: 'ret', label: '1Y return', format: 'signedPct', digits: 1 },
            { key: 'days', label: 'Days', format: 'int' },
          ],
          rows: [...rows, ...(peers.length ? [{ symbol: 'Peer median', vol: med('vol'), beta: med('beta'), corr: med('corr'), mdd: med('mdd'), ret: med('ret') }] : []), benchRow],
        },
      ],
      source: [...sources].join(', '),
      asOf: new Date(bench.bars[bench.bars.length - 1].t).toISOString().slice(0, 10),
      notes: [
        'From one year of daily closes: volatility is the annualised standard deviation of daily returns (252 days); beta and correlation are against the S&P 500; drawdown is the deepest peak-to-trough fall in the window. Price return, dividends not included.',
        auto ? 'Peers chosen automatically (same industry, nearest in market value); set "symbols" to choose your own.' : 'Peers as given.',
        ...(failed.length ? [`Left out: ${failed.join('; ')}`] : []),
      ],
    };
  },
};

const METRICS = { pe: 'P/E', ps: 'P/S', pb: 'P/B' } as const;

const valuationHistory: CardDef = {
  id: 'equities.valuation-history',
  title: 'Valuation multiple history',
  source: SEC,
  description: 'Month-end P/E, P/S and P/B over up to ten years, built from the figures on file at each date, against the median and the 10th to 90th percentile band.',
  params: [SYMBOL, { name: 'metric', label: 'Charted multiple', default: 'pe', choices: ['pe', 'ps', 'pb'] }],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const metric = (params.metric in METRICS ? params.metric : 'pe') as keyof typeof METRICS;
    const reg = await cikFor(ctx, symbol);
    const [cf, h] = await Promise.all([companyFacts(ctx, reg.cik), getHistory(ctx, symbol, '10Y')]);
    const f = fundamentals(cf);
    if (!f.shares.length || !f.netIncome.length) throw new SourceError(SEC, `no quarterly XBRL share and earnings facts for ${symbol} (foreign filers on Form 20-F or 40-F report annually)`);
    const series = multiplesAt(f, monthEnds(h.bars));
    const band = (k: keyof typeof METRICS): Row => {
      const vals = series.map((m) => m[k]);
      const last = [...vals].reverse().find((v) => v !== null) ?? null;
      const med = median(vals);
      return {
        multiple: METRICS[k],
        current: last,
        median: med,
        vsMedian: pctChange(last, med),
        p10: percentile(vals, 10),
        p90: percentile(vals, 90),
        min: percentile(vals, 0),
        max: percentile(vals, 100),
        months: vals.filter((v) => v !== null).length,
      };
    };
    const rows = (Object.keys(METRICS) as (keyof typeof METRICS)[]).map(band);
    const pts = series.filter((m) => m[metric] !== null).map((m) => [m.t, m[metric]!] as [number, number]);
    if (pts.length < 6) throw new SourceError(SEC, `too little history to chart ${METRICS[metric]} for ${symbol} (earnings, revenue or book value not positive, or facts missing)`);
    const chosen = rows[(Object.keys(METRICS) as string[]).indexOf(metric)];
    const flat = (name: string, v: number | null): { name: string; points: [number, number][] }[] => (v === null ? [] : [{ name, points: [[pts[0][0], v], [pts[pts.length - 1][0], v]] }]);
    return {
      blocks: [
        {
          kind: 'chart',
          title: `${symbol} ${METRICS[metric]} (month end)`,
          xType: 'time',
          series: [{ name: METRICS[metric], points: pts }, ...flat('Median', chosen.median as number | null), ...flat('10th pct', chosen.p10 as number | null), ...flat('90th pct', chosen.p90 as number | null)],
          yFormat: 'num',
          yDigits: 1,
        },
        {
          kind: 'table',
          columns: [
            { key: 'multiple', label: 'Multiple' },
            { key: 'current', label: 'Current', format: 'num', digits: 1 },
            { key: 'median', label: 'Median', format: 'num', digits: 1 },
            { key: 'vsMedian', label: 'vs median', format: 'signedPct', digits: 0 },
            { key: 'p10', label: '10th pct', format: 'num', digits: 1 },
            { key: 'p90', label: '90th pct', format: 'num', digits: 1 },
            { key: 'min', label: 'Low', format: 'num', digits: 1 },
            { key: 'max', label: 'High', format: 'num', digits: 1 },
            { key: 'months', label: 'Months', format: 'int' },
          ],
          rows,
        },
      ],
      source: `${SEC}, ${h.source}`,
      sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${reg.cik}&type=10-&dateb=&owner=include&count=40`,
      asOf: new Date(series[series.length - 1].t).toISOString().slice(0, 10),
      notes: [
        'Point in time: at each month end the multiple uses only what had been filed by then. Market value = close x weighted diluted shares of the latest filed quarter; earnings and revenue are the trailing four quarters (Q4 = year - 9 months); book value is the latest filed equity.',
        'Share counts are restated for stock splits by detecting split-sized jumps in reported shares, which matches the split-adjusted price history. Months with negative trailing earnings (or equity) have no P/E (or P/B).',
        'Price history from Nasdaq covers about ten years.',
      ],
    };
  },
};

export const peerCards: CardDef[] = [comps, risk, valuationHistory];
