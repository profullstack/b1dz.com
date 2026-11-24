/** Factors & Styles: factor ETF board, style box, cross-asset correlation and risk, relative rotation. */
import { classify, computeReturns, getHistory, mapLimit, returnsBoard, type Bar, type History } from '../../lib/market.js';
import { NASDAQ } from '../../lib/nasdaq.js';
import { SourceError, type CardDef, type Column, type Ctx, type Row } from '../../types.js';
import { align, annualVol, beta, correlation, dailyReturns, maxDrawdown, mean, symbolList, totalReturn } from './util.js';

const FACTORS = [
  { symbol: 'SPY', label: 'Market (S&P 500)' },
  { symbol: 'VTV', label: 'Value' },
  { symbol: 'VUG', label: 'Growth' },
  { symbol: 'MTUM', label: 'Momentum' },
  { symbol: 'QUAL', label: 'Quality' },
  { symbol: 'USMV', label: 'Low volatility' },
  { symbol: 'IWM', label: 'Size (small caps)' },
  { symbol: 'RSP', label: 'Equal weight' },
  { symbol: 'VYM', label: 'High dividend yield' },
  { symbol: 'SPHB', label: 'High beta' },
];

const factorBoard: CardDef = {
  id: 'equities.factor-board',
  title: 'Equity factors',
  source: NASDAQ,
  description: 'Value, growth, momentum, quality, low volatility, size and other factors through U.S. factor ETFs.',
  async run(ctx) {
    const b = await returnsBoard(ctx, FACTORS);
    return { blocks: [b.block], source: b.source, notes: [...b.notes, 'Long-only factor ETFs, so every row carries market exposure: compare each with the market row rather than with zero.'] };
  },
};

const STYLE: { size: string; value: string; core: string; growth: string }[] = [
  { size: 'Large cap', value: 'IWD', core: 'IWB', growth: 'IWF' },
  { size: 'Mid cap', value: 'IWS', core: 'IWR', growth: 'IWP' },
  { size: 'Small cap', value: 'IWN', core: 'IWM', growth: 'IWO' },
];
const HORIZONS = { '1W': 'w1', '1M': 'm1', '3M': 'm3', YTD: 'ytd', '1Y': 'y1' } as const;

const styleBox: CardDef = {
  id: 'equities.style-box',
  title: 'U.S. equity style box',
  source: NASDAQ,
  description: 'Returns of large, mid and small caps split into value, core and growth (Russell style ETFs) over a chosen horizon.',
  params: [{ name: 'horizon', label: 'Horizon', default: 'YTD', choices: Object.keys(HORIZONS) }],
  async run(ctx, params) {
    const horizon = ((params.horizon ?? 'YTD').toUpperCase() in HORIZONS ? (params.horizon ?? 'YTD').toUpperCase() : 'YTD') as keyof typeof HORIZONS;
    const key = HORIZONS[horizon];
    const symbols = STYLE.flatMap((s) => [s.value, s.core, s.growth]);
    const hist = await mapLimit(symbols, 4, (s) => getHistory(ctx, s, '1Y'));
    const ret = new Map(symbols.map((s, i) => [s, computeReturns(hist[i].bars)]));
    const rows: Row[] = STYLE.map((s) => {
      const v = ret.get(s.value)![key];
      const g = ret.get(s.growth)![key];
      return { size: s.size, value: v, core: ret.get(s.core)![key], growth: g, spread: v !== null && g !== null ? g - v : null };
    });
    const detail: Row[] = STYLE.flatMap((s) => (['value', 'core', 'growth'] as const).map((k) => {
      const r = ret.get(s[k])!;
      return { style: `${s.size} ${k}`, symbol: s[k], last: r.last, day: r.day, w1: r.w1, m1: r.m1, m3: r.m3, ytd: r.ytd, y1: r.y1 };
    }));
    const pctCol = (key2: string, label: string): Column => ({ key: key2, label, format: 'signedPct' });
    const asOf = Math.max(...hist.map((h) => h.bars[h.bars.length - 1].t));
    return {
      blocks: [
        { kind: 'table', title: `Return, ${horizon}`, columns: [{ key: 'size', label: '' }, pctCol('value', 'Value'), pctCol('core', 'Core'), pctCol('growth', 'Growth'), pctCol('spread', 'Growth - value')], rows },
        { kind: 'table', title: 'All horizons', columns: [{ key: 'style', label: 'Style' }, { key: 'symbol', label: 'ETF' }, { key: 'last', label: 'Last', format: 'num' }, pctCol('day', 'Day'), pctCol('w1', '1W'), pctCol('m1', '1M'), pctCol('m3', '3M'), pctCol('ytd', 'YTD'), pctCol('y1', '1Y')], rows: detail },
      ],
      source: [...new Set(hist.map((h) => h.source))].join(', '),
      asOf: new Date(asOf).toISOString().slice(0, 10),
      notes: ['iShares Russell 1000, Mid-Cap and 2000 ETFs (value, blend, growth). Price return from daily closes; dividends not included, which slightly understates value.'],
    };
  },
};

const CROSS_ASSET = 'SPY,QQQ,IWM,EFA,EEM,TLT,IEF,LQD,HYG,GLD,USO,UUP,BTC-USD';
const ASSET_NAMES: Record<string, string> = {
  SPY: 'U.S. large caps', QQQ: 'Nasdaq-100', IWM: 'U.S. small caps', EFA: 'Developed ex-U.S.', EEM: 'Emerging markets', TLT: 'Treasuries 20Y+', IEF: 'Treasuries 7-10Y',
  LQD: 'Investment-grade credit', HYG: 'High-yield credit', GLD: 'Gold', USO: 'Crude oil', UUP: 'U.S. dollar', 'BTC-USD': 'Bitcoin',
};
const ASSETS = { name: 'symbols', label: 'Assets', default: CROSS_ASSET, hint: 'comma list of symbols (ETFs, stocks, indices, crypto)' };
const WINDOW = { name: 'range', label: 'Window', default: '1Y', choices: ['3M', '6M', '1Y', '2Y', '5Y'] };

async function histories(ctx: Ctx, symbols: string[], range: string): Promise<{ got: History[]; failed: string[] }> {
  const r = (['3M', '6M', '1Y', '2Y', '5Y'].includes(range) ? range : '1Y') as '1Y';
  const failed: string[] = [];
  const all = await mapLimit(symbols, 4, async (s) => {
    try {
      return await getHistory(ctx, s, r);
    } catch (e) {
      failed.push(`${s} (${(e as Error).message})`);
      return null;
    }
  });
  const got = all.filter((h): h is History => h !== null);
  if (got.length < 2) throw new SourceError('Market data', `need at least two symbols with history; ${failed.join('; ')}`);
  return { got, failed };
}

/** Correlation of daily returns for every pair, on the days both traded. */
export function correlationMatrix(series: { symbol: string; bars: Bar[] }[]): (number | null)[][] {
  const rets = series.map((s) => dailyReturns(s.bars));
  return series.map((_, i) => series.map((__, j) => {
    if (i === j) return 1;
    const { x, y } = align(rets[i], rets[j]);
    return correlation(x, y);
  }));
}

const correlations: CardDef = {
  id: 'equities.correlations',
  title: 'Cross-asset correlation matrix',
  source: NASDAQ,
  description: 'Correlation of daily returns between equities, bonds, credit, gold, oil, the dollar and bitcoin (or any symbols you give).',
  params: [ASSETS, WINDOW],
  async run(ctx, params) {
    const symbols = symbolList(params.symbols || CROSS_ASSET).slice(0, 14);
    const { got, failed } = await histories(ctx, symbols, params.range);
    const m = correlationMatrix(got);
    const columns: Column[] = [{ key: 'asset', label: 'Asset', maxWidth: 24 }, { key: 'symbol', label: '' }, ...got.map((h) => ({ key: h.symbol, label: h.symbol.replace('-USD', ''), format: 'num' as const, digits: 2 }))];
    const rows: Row[] = got.map((h, i) => {
      const row: Row = { asset: ASSET_NAMES[h.symbol] ?? h.symbol, symbol: h.symbol.replace('-USD', '') };
      got.forEach((g, j) => {
        row[g.symbol] = m[i][j];
      });
      return row;
    });
    const last = Math.max(...got.map((h) => h.bars[h.bars.length - 1].t));
    return {
      blocks: [{ kind: 'table', title: `Daily-return correlation, ${params.range || '1Y'}`, columns, rows }],
      source: [...new Set(got.map((h) => h.source))].join(', '),
      asOf: new Date(last).toISOString().slice(0, 10),
      notes: ['Pearson correlation of simple daily price returns on the days both assets traded (bitcoin weekends are dropped). ETFs stand in for each asset class; dividends and coupons are not included.', ...(failed.length ? [`Left out: ${failed.join('; ')}`] : [])],
    };
  },
};

const riskStats: CardDef = {
  id: 'equities.risk-stats',
  title: 'Cross-asset risk statistics',
  source: NASDAQ,
  description: 'Return, annualised volatility, return per unit of risk, maximum drawdown and beta to U.S. equities for each asset.',
  params: [ASSETS, WINDOW],
  async run(ctx, params) {
    const symbols = symbolList(params.symbols || CROSS_ASSET).slice(0, 14);
    const { got, failed } = await histories(ctx, symbols, params.range);
    const bench = got.find((h) => h.symbol === 'SPY') ?? (await getHistory(ctx, 'SPY', (WINDOW.choices.includes(params.range) ? params.range : '1Y') as '1Y'));
    const benchRet = dailyReturns(bench.bars);
    const rows: Row[] = got.map((h) => {
      const r = dailyReturns(h.bars);
      const vals = [...r.values()];
      // Crypto trades every day; everything else about 252 days a year.
      const periods = classify(h.symbol) === 'crypto' ? 365 : 252;
      const vol = annualVol(vals, periods);
      const ann = vals.length ? mean(vals) * periods * 100 : null;
      const { x, y } = align(benchRet, r);
      return { asset: ASSET_NAMES[h.symbol] ?? h.symbol, symbol: h.symbol, ret: totalReturn(h.bars), ann, vol, ratio: ann !== null && vol ? ann / vol : null, mdd: maxDrawdown(h.bars), beta: beta(x, y), corr: correlation(x, y) };
    });
    const last = Math.max(...got.map((h) => h.bars[h.bars.length - 1].t));
    return {
      blocks: [
        {
          kind: 'table',
          title: `Window: ${params.range || '1Y'}`,
          columns: [
            { key: 'asset', label: 'Asset', maxWidth: 24 },
            { key: 'symbol', label: 'Symbol' },
            { key: 'ret', label: 'Return', format: 'signedPct', digits: 1 },
            { key: 'ann', label: 'Ann. return', format: 'signedPct', digits: 1 },
            { key: 'vol', label: 'Ann. vol', format: 'pct', digits: 1 },
            { key: 'ratio', label: 'Return/vol', format: 'num', digits: 2 },
            { key: 'mdd', label: 'Max drawdown', format: 'signedPct', digits: 1 },
            { key: 'beta', label: 'Beta to SPY', format: 'num', digits: 2 },
            { key: 'corr', label: 'Corr. to SPY', format: 'num', digits: 2 },
          ],
          rows,
        },
      ],
      source: [...new Set(got.map((h) => h.source))].join(', '),
      asOf: new Date(last).toISOString().slice(0, 10),
      notes: ['Annualised return is the mean daily return x trading days (arithmetic); return/vol divides it by annualised volatility with no risk-free rate subtracted, so it is not a Sharpe ratio. Price return only.', ...(failed.length ? [`Left out: ${failed.join('; ')}`] : [])],
    };
  },
};

export interface Rotation {
  ratio: number | null;
  momentum: number | null;
  quadrant: string;
}

/**
 * Relative rotation against a benchmark. Relative strength RS = price / benchmark.
 * `ratio` = 100 x RS / its `slow`-day average (above 100: outperforming its
 * own trend); `momentum` = 100 x ratio / the ratio `fast` days ago (above
 * 100: the outperformance is building).
 */
export function rotation(asset: Bar[], bench: Bar[], slow = 63, fast = 21): Rotation {
  const b = new Map(bench.map((x) => [x.t, x.c]));
  const rs = asset.filter((x) => b.has(x.t) && b.get(x.t)! > 0).map((x) => x.c / b.get(x.t)!);
  const ratioAt = (end: number): number | null => {
    if (end < slow || end > rs.length) return null;
    const avg = mean(rs.slice(end - slow, end));
    return avg > 0 ? (100 * rs[end - 1]) / avg : null;
  };
  const ratio = ratioAt(rs.length);
  const before = ratioAt(rs.length - fast);
  const momentum = ratio !== null && before !== null && before > 0 ? (100 * ratio) / before : null;
  const quadrant = ratio === null || momentum === null ? '' : ratio >= 100 ? (momentum >= 100 ? 'Leading' : 'Weakening') : momentum >= 100 ? 'Improving' : 'Lagging';
  return { ratio, momentum, quadrant };
}

const SECTOR_ETFS = 'XLK,XLC,XLY,XLP,XLF,XLV,XLI,XLE,XLB,XLRE,XLU';
const SECTOR_NAMES: Record<string, string> = { XLK: 'Technology', XLC: 'Communication Services', XLY: 'Consumer Discretionary', XLP: 'Consumer Staples', XLF: 'Financials', XLV: 'Health Care', XLI: 'Industrials', XLE: 'Energy', XLB: 'Materials', XLRE: 'Real Estate', XLU: 'Utilities' };

const rotationCard: CardDef = {
  id: 'equities.rotation',
  title: 'Relative rotation',
  source: NASDAQ,
  description: 'Relative strength and its momentum against a benchmark for the U.S. sectors (or any symbols), sorted into leading, weakening, lagging and improving.',
  params: [
    { name: 'symbols', label: 'Symbols', default: SECTOR_ETFS, hint: 'comma list; default is the eleven sector ETFs' },
    { name: 'benchmark', label: 'Benchmark', default: 'SPY' },
  ],
  async run(ctx, params) {
    const benchSym = (params.benchmark || 'SPY').trim().toUpperCase();
    const symbols = symbolList(params.symbols || SECTOR_ETFS).filter((s) => s !== benchSym).slice(0, 20);
    const bench = await getHistory(ctx, benchSym, '1Y');
    const failed: string[] = [];
    const rows = (await mapLimit(symbols, 4, async (s): Promise<Row | null> => {
      try {
        const h = await getHistory(ctx, s, '1Y');
        const r = rotation(h.bars, bench.bars);
        const rel3 = computeReturns(h.bars).m3;
        const b3 = computeReturns(bench.bars).m3;
        return { name: SECTOR_NAMES[s] ?? s, symbol: s, quadrant: r.quadrant, ratio: r.ratio, momentum: r.momentum, excess: rel3 !== null && b3 !== null ? rel3 - b3 : null };
      } catch (e) {
        failed.push(`${s} (${(e as Error).message})`);
        return null;
      }
    })).filter((r): r is Row => r !== null);
    if (!rows.length) throw new SourceError(NASDAQ, `no history for the symbols given; ${failed.join('; ')}`);
    rows.sort((a, b) => ((b.ratio as number | null) ?? 0) - ((a.ratio as number | null) ?? 0));
    return {
      blocks: [
        {
          kind: 'table',
          title: `Rotation against ${benchSym}`,
          columns: [
            { key: 'name', label: 'Name', maxWidth: 26 },
            { key: 'symbol', label: 'Symbol' },
            { key: 'quadrant', label: 'Quadrant' },
            { key: 'ratio', label: 'RS ratio', format: 'num', digits: 2 },
            { key: 'momentum', label: 'RS momentum', format: 'num', digits: 2 },
            { key: 'excess', label: '3M excess return', format: 'signedPct' },
          ],
          rows,
        },
      ],
      source: bench.source,
      asOf: new Date(bench.bars[bench.bars.length - 1].t).toISOString().slice(0, 10),
      notes: [
        'RS ratio = 100 x (price / benchmark) over its 63-day average; RS momentum = 100 x RS ratio over its value 21 trading days ago. Leading: both at or above 100. Weakening: ratio above, momentum below. Lagging: both below. Improving: ratio below, momentum above.',
        'A simple, transparent construction; it will not match proprietary relative rotation graphs.',
        ...(failed.length ? [`Left out: ${failed.join('; ')}`] : []),
      ],
    };
  },
};

export const factorCards: CardDef[] = [factorBoard, styleBox, correlations, riskStats, rotationCard];
