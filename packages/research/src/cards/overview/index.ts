/**
 * Overview: the cross-asset summary, watchlists, the compare chart, a single
 * security chart, and Data status.
 */
import { fredSeries } from '../../lib/fred.js';
import { RANGES, getHistory, rangeStart, returnsBoard, type Range } from '../../lib/market.js';
import { KEY_INFO, KEY_NAMES } from '../../registry.js';
import { combine, drawdown, indexed, sma } from '../../transform.js';
import type { AreaModule, CardDef, CardResult, Ctx, DashboardDef, ParamSpec, Series } from '../../types.js';

const RANGE: ParamSpec = { name: 'range', label: 'Range', default: '1Y', choices: RANGES };

function asRange(v: string | undefined): Range {
  const r = (v ?? '1Y').toUpperCase() as Range;
  return RANGES.includes(r) ? r : '1Y';
}

function symbolList(v: string | undefined, max: number): string[] {
  return [...new Set((v ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))].slice(0, max);
}

/** A fixed board of symbols with returns over five horizons. */
function board(id: string, title: string, description: string, items: { symbol: string; label: string }[]): CardDef {
  return {
    id,
    title,
    source: 'Nasdaq',
    description,
    async run(ctx): Promise<CardResult> {
      const { block, source, notes } = await returnsBoard(ctx, items);
      return { blocks: [block], source, notes };
    },
  };
}

/** History for a symbol, or a FRED series when written `FRED:DGS10`. */
async function seriesFor(ctx: Ctx, symbol: string, range: Range): Promise<{ name: string; points: [number, number][]; source: string }> {
  if (/^fred:/i.test(symbol)) {
    const id = symbol.slice(5).toUpperCase();
    const start = rangeStart(range, ctx.now()).toISOString().slice(0, 10);
    const s = await fredSeries(ctx, id, { start: range === 'MAX' ? '1950-01-01' : start });
    return { name: id, points: s.points, source: s.source };
  }
  const h = await getHistory(ctx, symbol, range);
  return { name: symbol.toUpperCase(), points: h.bars.map((b) => [b.t, b.c]), source: h.source };
}

const MODES = ['pct', 'price', 'ratio', 'spread', 'drawdown'];

const cards: CardDef[] = [
  {
    id: 'overview.watchlist',
    title: 'Watchlist',
    source: 'Nasdaq',
    description: 'Your tickers: last price, day change and returns over five horizons.',
    params: [{ name: 'symbols', label: 'Symbols', default: 'AAPL,MSFT,NVDA,AMZN,GOOGL,SPY,QQQ,BTC-USD', hint: 'comma separated tickers' }],
    async run(ctx, p) {
      const symbols = symbolList(p.symbols, 40);
      const { block, source, notes } = await returnsBoard(ctx, symbols.map((symbol) => ({ symbol })));
      return { blocks: [block], source, notes };
    },
  },
  board('overview.us-indices', 'U.S. indices', 'Major U.S. equity indices and volatility.', [
    { symbol: '^GSPC', label: 'S&P 500' },
    { symbol: '^NDX', label: 'Nasdaq-100' },
    { symbol: '^IXIC', label: 'Nasdaq Composite' },
    { symbol: '^DJI', label: 'Dow Jones Industrial' },
    { symbol: '^RUT', label: 'Russell 2000' },
    { symbol: '^VIX', label: 'VIX' },
  ]),
  board('overview.us-sectors', 'U.S. sectors', 'The eleven S&P 500 sectors through their sector ETFs.', [
    { symbol: 'XLK', label: 'Technology' },
    { symbol: 'XLC', label: 'Communication Services' },
    { symbol: 'XLY', label: 'Consumer Discretionary' },
    { symbol: 'XLP', label: 'Consumer Staples' },
    { symbol: 'XLF', label: 'Financials' },
    { symbol: 'XLV', label: 'Health Care' },
    { symbol: 'XLI', label: 'Industrials' },
    { symbol: 'XLE', label: 'Energy' },
    { symbol: 'XLB', label: 'Materials' },
    { symbol: 'XLRE', label: 'Real Estate' },
    { symbol: 'XLU', label: 'Utilities' },
  ]),
  board('overview.country-etfs', 'Country ETFs', 'Single-country equity ETFs, in U.S. dollars.', [
    { symbol: 'SPY', label: 'United States' },
    { symbol: 'EWC', label: 'Canada' },
    { symbol: 'EWW', label: 'Mexico' },
    { symbol: 'EWZ', label: 'Brazil' },
    { symbol: 'EWU', label: 'United Kingdom' },
    { symbol: 'EWG', label: 'Germany' },
    { symbol: 'EWQ', label: 'France' },
    { symbol: 'EWI', label: 'Italy' },
    { symbol: 'EWP', label: 'Spain' },
    { symbol: 'EWL', label: 'Switzerland' },
    { symbol: 'EWJ', label: 'Japan' },
    { symbol: 'MCHI', label: 'China' },
    { symbol: 'INDA', label: 'India' },
    { symbol: 'EWY', label: 'South Korea' },
    { symbol: 'EWT', label: 'Taiwan' },
    { symbol: 'EWA', label: 'Australia' },
  ]),
  board('overview.cross-asset', 'Cross-asset', 'Stocks, bonds, credit, gold, oil, the dollar and bitcoin through liquid ETFs.', [
    { symbol: 'SPY', label: 'U.S. equities' },
    { symbol: 'EFA', label: 'Developed ex-U.S. equities' },
    { symbol: 'EEM', label: 'Emerging equities' },
    { symbol: 'TLT', label: 'Treasuries 20Y+' },
    { symbol: 'IEF', label: 'Treasuries 7-10Y' },
    { symbol: 'LQD', label: 'Investment-grade credit' },
    { symbol: 'HYG', label: 'High-yield credit' },
    { symbol: 'GLD', label: 'Gold' },
    { symbol: 'USO', label: 'Crude oil' },
    { symbol: 'UUP', label: 'U.S. dollar' },
    { symbol: 'BTC-USD', label: 'Bitcoin' },
  ]),
  {
    id: 'overview.normalized',
    title: 'Normalized returns',
    source: 'Nasdaq',
    description: 'Several securities rebased to 100 at the start of the range.',
    params: [{ name: 'symbols', label: 'Symbols', default: 'SPY,QQQ,IWM,TLT,GLD', hint: 'up to eight tickers' }, RANGE],
    async run(ctx, p) {
      const range = asRange(p.range);
      const got = await Promise.allSettled(symbolList(p.symbols, 8).map((s) => seriesFor(ctx, s, range)));
      const series: Series[] = [];
      const notes: string[] = [];
      const sources = new Set<string>();
      got.forEach((g) => {
        if (g.status === 'fulfilled') {
          series.push({ name: g.value.name, points: indexed(g.value.points) });
          sources.add(g.value.source);
        } else notes.push((g.reason as Error).message);
      });
      if (!series.length) throw got[0].status === 'rejected' ? got[0].reason : new Error('nothing to plot');
      return { blocks: [{ kind: 'chart', xType: 'time', series, yDigits: 1 }], source: [...sources].join(', '), notes: [...notes, 'Price return, rebased to 100.'] };
    },
  },
  {
    id: 'overview.compare',
    title: 'Compare',
    source: 'Nasdaq',
    description: 'Up to eight securities or FRED series (FRED:DGS10) on one axis: percent change, price, ratio, spread or drawdown.',
    params: [
      { name: 'symbols', label: 'Symbols', default: 'SPY,QQQ', hint: 'tickers or FRED:SERIES, comma separated' },
      RANGE,
      { name: 'mode', label: 'Mode', default: 'pct', choices: MODES, hint: 'ratio and spread use the first two symbols' },
    ],
    async run(ctx, p) {
      const range = asRange(p.range);
      const mode = MODES.includes(p.mode) ? p.mode : 'pct';
      const symbols = symbolList(p.symbols, 8);
      const got = await Promise.allSettled(symbols.map((s) => seriesFor(ctx, s, range)));
      const ok = got.flatMap((g) => (g.status === 'fulfilled' ? [g.value] : []));
      const notes = got.flatMap((g) => (g.status === 'rejected' ? [(g.reason as Error).message] : []));
      if (!ok.length) throw got[0]?.status === 'rejected' ? got[0].reason : new Error('nothing to plot');
      const source = [...new Set(ok.map((o) => o.source))].join(', ');
      let series: Series[];
      let yFormat: 'num' | 'pct' = 'num';
      if (mode === 'ratio' || mode === 'spread') {
        if (ok.length < 2) throw new Error(`${mode} needs two symbols`);
        const f = mode === 'ratio' ? (a: number, b: number) => a / b : (a: number, b: number) => a - b;
        series = [{ name: `${ok[0].name} ${mode === 'ratio' ? '/' : '-'} ${ok[1].name}`, points: combine(ok[0].points, ok[1].points, f) }];
      } else if (mode === 'drawdown') {
        series = ok.map((o) => ({ name: o.name, points: drawdown(o.points) }));
        yFormat = 'pct';
      } else if (mode === 'price') {
        series = ok.map((o) => ({ name: o.name, points: o.points }));
      } else {
        series = ok.map((o) => ({ name: o.name, points: indexed(o.points).map(([x, y]) => [x, y - 100] as [number, number]) }));
        yFormat = 'pct';
      }
      return { blocks: [{ kind: 'chart', xType: 'time', series, yFormat, yDigits: yFormat === 'pct' ? 1 : undefined }], source, notes };
    },
  },
  {
    id: 'overview.chart',
    title: 'Price chart',
    source: 'Nasdaq',
    description: 'Daily closes with the 50- and 200-day moving averages, and the range statistics.',
    params: [{ name: 'symbol', label: 'Symbol', default: 'SPY', hint: 'ticker, index (^GSPC), pair (EURUSD=X), future (CL=F) or coin (BTC-USD)' }, RANGE],
    async run(ctx, p) {
      const range = asRange(p.range);
      const h = await getHistory(ctx, p.symbol, range);
      if (!h.bars.length) throw new Error(`no history for ${p.symbol}`);
      const closes: [number, number][] = h.bars.map((b) => [b.t, b.c]);
      const series: Series[] = [{ name: h.symbol, points: closes }];
      if (closes.length > 60) series.push({ name: '50d', points: sma(closes, 50) });
      if (closes.length > 220) series.push({ name: '200d', points: sma(closes, 200) });
      const last = h.bars[h.bars.length - 1];
      const first = h.bars[0];
      const hi = Math.max(...h.bars.map((b) => b.h));
      const lo = Math.min(...h.bars.map((b) => b.l));
      const dd = drawdown(closes);
      const volumes = h.bars.map((b) => b.v).filter((v): v is number => typeof v === 'number');
      return {
        blocks: [
          { kind: 'chart', xType: 'time', series },
          {
            kind: 'stats',
            items: [
              { label: 'Last', value: last.c, format: 'num' },
              { label: `Change (${range})`, value: ((last.c - first.c) / first.c) * 100, format: 'signedPct' },
              { label: 'High', value: hi, format: 'num' },
              { label: 'Low', value: lo, format: 'num' },
              { label: 'From high', value: (last.c / hi - 1) * 100, format: 'signedPct' },
              { label: 'Max drawdown', value: Math.min(...dd.map((d) => d[1])), format: 'signedPct' },
              { label: 'Avg volume', value: volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : null, format: 'compact' },
              { label: 'Currency', value: h.currency ?? '' },
            ],
          },
        ],
        source: h.source,
        asOf: new Date(last.t).toISOString().slice(0, 10),
        notes: ['Daily bars. Quotes can be delayed.'],
      };
    },
  },
  {
    id: 'overview.status',
    title: 'Data status',
    source: 'b1dz',
    description: 'Which sources answered or failed in this session.',
    async run(ctx) {
      const health = ctx.http.health();
      return {
        blocks: [
          {
            kind: 'table',
            columns: [
              { key: 'source', label: 'Source' },
              { key: 'state', label: 'State' },
              { key: 'ok', label: 'OK', format: 'int' },
              { key: 'failed', label: 'Failed', format: 'int' },
              { key: 'lastOk', label: 'Last OK', format: 'datetime' },
              { key: 'error', label: 'Last error', maxWidth: 50 },
            ],
            rows: health.map((h) => ({
              source: h.source,
              state: h.failed === 0 ? 'up' : h.ok === 0 ? 'DOWN' : (h.lastErrorAt ?? '') > (h.lastOkAt ?? '') ? 'failing' : 'recovered',
              ok: h.ok,
              failed: h.failed,
              lastOk: h.lastOkAt ?? null,
              error: h.lastError ?? '',
            })),
            footnote: health.length ? undefined : 'No source has been queried yet in this session. Open a dashboard, then come back.',
          },
        ],
        notes: ['Counts cover this session only. Cached answers are not re-counted.'],
      };
    },
  },
  {
    id: 'overview.keys',
    title: 'API keys',
    source: 'b1dz',
    description: 'Optional free keys and whether each is configured.',
    async run(ctx) {
      return {
        blocks: [
          {
            kind: 'table',
            columns: [
              { key: 'key', label: 'Key' },
              { key: 'state', label: 'Configured' },
              { key: 'adds', label: 'What it adds', maxWidth: 70 },
              { key: 'signup', label: 'Free sign-up', maxWidth: 48 },
            ],
            rows: KEY_NAMES.map((k) => ({ key: k, state: ctx.key(k) ? 'yes' : 'no', adds: KEY_INFO[k].adds, signup: KEY_INFO[k].signup })),
            footnote: 'Add one with: b1dz research keys set <KEY> <value>   (or set the environment variable, e.g. FRED_API_KEY).',
          },
        ],
        notes: ['Keys are kept on this machine and are sent only to the provider they belong to.'],
      };
    },
  },
];

const dashboards: DashboardDef[] = [
  {
    id: 'summary',
    title: 'Markets Summary',
    group: 'Overview',
    tabs: [
      {
        id: 'summary',
        title: 'Summary',
        // Cards from other areas are skipped by the surfaces if that area is not registered.
        cards: [
          'overview.watchlist',
          'macro.news-markets',
          'overview.us-indices',
          'overview.cross-asset',
          'overview.us-sectors',
          'overview.normalized',
          'fx.board',
          'overview.country-etfs',
          'rates.global-yields',
          'equities.style-box',
          'derivatives.futures-board',
          'macro.chokepoints',
          'equities.earnings-calendar',
          'equities.economic-calendar',
        ],
      },
      { id: 'compare', title: 'Compare', cards: ['overview.compare'] },
      { id: 'chart', title: 'Chart', cards: ['overview.chart'] },
      { id: 'status', title: 'Data status', cards: ['overview.status', 'overview.keys'] },
    ],
  },
];

export const overview: AreaModule = { cards, dashboards };
