import { describe, expect, it } from 'vitest';
import type { ChartBlock } from '@b1dz/research/types';
import {
  barGeometry,
  cardKey,
  cardUrl,
  chunk,
  groupDashboards,
  watchQuotes,
  lineGeometry,
  localSearch,
  nearestIndex,
  paramsForCard,
  searchFromView,
  tabParams,
  valueAt,
  viewFromSearch,
  type Catalog,
} from './logic';

describe('watchlist panel helpers', () => {
  it('reads last and day change per symbol from the Watchlist card', () => {
    const blocks = [
      { kind: 'text' },
      {
        kind: 'table',
        rows: [
          { name: 'AAPL', symbol: 'aapl', last: 349.08, day: -1.25, w1: 2 },
          { name: 'Bitcoin', symbol: 'BTC-USD', last: 91000 },
          { name: 'No data', symbol: 'ZZZZ' },
          { name: 'no symbol', last: 5 },
        ],
      },
    ];
    expect(watchQuotes(blocks)).toEqual({
      AAPL: { last: 349.08, day: -1.25 },
      'BTC-USD': { last: 91000, day: null },
      ZZZZ: { last: null, day: null },
    });
    expect(watchQuotes(undefined)).toEqual({});
  });

  it('chunks a long list', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 40)).toEqual([]);
  });
});

const catalog: Catalog = {
  dashboards: [
    { id: 'summary', title: 'Markets Summary', group: 'Overview', tabs: [{ id: 'summary', title: 'Summary', cards: ['overview.watchlist'] }, { id: 'chart', title: 'Chart', cards: ['overview.chart'] }] },
    { id: 'company', title: 'Company', group: 'Equities', tabs: [{ id: 'overview', title: 'Overview', cards: ['equities.price', 'equities.snapshot'] }] },
    { id: 'screeners', title: 'Screeners & Movers', group: 'Equities', tabs: [{ id: 'movers', title: 'Movers', cards: [] }] },
  ],
  cards: [
    { id: 'overview.watchlist', title: 'Watchlist', source: 'Nasdaq', params: [{ name: 'symbols', label: 'Symbols', default: 'AAPL' }] },
    { id: 'overview.chart', title: 'Price chart', source: 'Nasdaq', params: [{ name: 'symbol', label: 'Symbol', default: 'SPY' }, { name: 'range', label: 'Range', default: '1Y' }] },
    { id: 'equities.price', title: 'Price history', source: 'Nasdaq', params: [{ name: 'symbol', label: 'Symbol', default: 'AAPL' }, { name: 'range', label: 'Range', default: '1Y' }] },
    { id: 'equities.snapshot', title: 'Business snapshot', source: 'Nasdaq', params: [{ name: 'symbol', label: 'Ticker', default: 'AAPL' }] },
  ],
};
const cards = new Map(catalog.cards.map((c) => [c.id, c]));

describe('catalog helpers', () => {
  it('groups consecutive dashboards under one heading', () => {
    expect(groupDashboards(catalog.dashboards).map((g) => [g.group, g.items.map((d) => d.id)])).toEqual([
      ['Overview', ['summary']],
      ['Equities', ['company', 'screeners']],
    ]);
  });

  it('collects each param once per tab, first definition wins', () => {
    expect(tabParams(['equities.price', 'equities.snapshot', 'missing'], cards)).toEqual([
      { name: 'symbol', label: 'Symbol', default: 'AAPL' },
      { name: 'range', label: 'Range', default: '1Y' },
    ]);
  });

  it('sends a card only the params it declares, and leaves defaults to the server', () => {
    expect(paramsForCard(cards.get('equities.snapshot'), { symbol: ' NVDA ', range: '5Y', bogus: 'x' })).toEqual({ symbol: 'NVDA' });
    expect(paramsForCard(cards.get('equities.price'), { symbol: '' })).toEqual({});
    expect(paramsForCard(undefined, { symbol: 'X' })).toEqual({});
  });

  it('builds stable keys and API URLs', () => {
    expect(cardKey('a.b', { range: '1Y', symbol: 'NVDA' })).toBe(cardKey('a.b', { symbol: 'NVDA', range: '1Y' }));
    expect(cardUrl('equities.price', { symbol: 'BRK-B', range: '1Y' })).toBe('/api/research/card/equities.price?symbol=BRK-B&range=1Y');
    expect(cardUrl('overview.status', {})).toBe('/api/research/card/overview.status');
    expect(cardUrl('fx.board', { symbol: 'EURUSD=X' }, 'csv')).toBe('/api/research/card/fx.board?symbol=EURUSD%3DX&format=csv');
  });

  it('finds dashboards, tabs and cards by name', () => {
    expect(localSearch(catalog, 'company')[0]).toEqual({ label: 'Company', detail: 'Equities', dashboard: 'company' });
    expect(localSearch(catalog, 'snapshot')).toEqual([{ label: 'Business snapshot', detail: 'Company › Overview', dashboard: 'company', tab: 'overview' }]);
    expect(localSearch(catalog, '  ')).toEqual([]);
    expect(localSearch(catalog, 'zzz')).toEqual([]);
  });
});

describe('URL state', () => {
  it('reads a shared link', () => {
    expect(viewFromSearch('?d=company&t=overview&symbol=NVDA&range=5Y', catalog)).toEqual({ dashboard: 'company', tab: 'overview', params: { symbol: 'NVDA', range: '5Y' } });
  });

  it('falls back to the first dashboard and tab for unknown ids', () => {
    expect(viewFromSearch('?d=nope&t=nope', catalog)).toEqual({ dashboard: 'summary', tab: 'summary', params: {} });
    expect(viewFromSearch('?d=company&t=nope', catalog).tab).toBe('overview');
  });

  it('uses the remembered view only when the link names none', () => {
    expect(viewFromSearch('', catalog, { dashboard: 'summary', tab: 'chart' })).toMatchObject({ dashboard: 'summary', tab: 'chart' });
    expect(viewFromSearch('?d=company', catalog, { dashboard: 'summary', tab: 'chart' })).toMatchObject({ dashboard: 'company', tab: 'overview' });
  });

  it('round-trips through the address bar', () => {
    const view = { dashboard: 'company', tab: 'overview', params: { symbol: 'RY.TO', range: '2Y' } };
    expect(searchFromView(view)).toBe('?d=company&t=overview&symbol=RY.TO&range=2Y');
    expect(viewFromSearch(searchFromView(view), catalog)).toEqual(view);
  });

  it('survives an empty catalog', () => {
    expect(viewFromSearch('?d=x', { dashboards: [], cards: [] })).toEqual({ dashboard: '', tab: '', params: {} });
  });
});

describe('chart geometry', () => {
  const day = 86_400_000;
  const t0 = Date.UTC(2026, 0, 1);
  const rising: ChartBlock = { kind: 'chart', xType: 'time', series: [{ name: 'SPY', points: Array.from({ length: 11 }, (_, i) => [t0 + i * day, 100 + i * 10] as [number, number]) }] };

  it('maps the data into the plot area, later and higher to the right and up', () => {
    const g = lineGeometry(rising, 600, 200)!;
    expect(g.lines).toHaveLength(1);
    const pts = g.lines[0].path.slice(1).split('L').map((p) => p.split(' ').map(Number));
    expect(pts).toHaveLength(11);
    expect(pts[0][0]).toBeCloseTo(g.plot.left, 1);
    expect(pts[10][0]).toBeCloseTo(g.plot.right, 1);
    expect(pts[10][1]).toBeLessThan(pts[0][1]);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(g.plot.left - 0.1);
      expect(x).toBeLessThanOrEqual(g.plot.right + 0.1);
      expect(y).toBeGreaterThanOrEqual(g.plot.top - 0.1);
      expect(y).toBeLessThanOrEqual(g.plot.bottom + 0.1);
    }
    expect(g.lines[0].last).toBe(200);
    expect(g.xTicks.map((t) => t.label)).toEqual(['2026-01-01', '2026-01-06', '2026-01-11']);
    expect(g.zeroY).toBeNull();
    expect(g.xs).toHaveLength(11);
  });

  it('draws a zero line when the range crosses zero, and labels a curve axis', () => {
    const curve: ChartBlock = { kind: 'chart', xType: 'number', xLabel: 'Years', yFormat: 'pct', series: [{ name: 'chg', points: [[1, -0.5], [10, 0.75]] }] };
    const g = lineGeometry(curve, 400, 160)!;
    expect(g.zeroY).not.toBeNull();
    expect(g.zeroY!).toBeGreaterThan(g.plot.top);
    expect(g.zeroY!).toBeLessThan(g.plot.bottom);
    expect(g.xTicks[1].label).toBe('Years');
    expect(g.yTicks[0].label).toMatch(/%$/);
  });

  it('handles a single point, flat series and bad values without dividing by zero', () => {
    const one = lineGeometry({ kind: 'chart', xType: 'time', series: [{ name: 'a', points: [[t0, 5]] }] }, 300, 120)!;
    expect(one.lines[0].path).toMatch(/^M[\d.]+ [\d.]+$/);
    const flat = lineGeometry({ kind: 'chart', xType: 'time', series: [{ name: 'a', points: [[t0, 5], [t0 + day, 5]] }] }, 300, 120)!;
    expect(flat.lines[0].path).not.toContain('NaN');
    expect(lineGeometry({ kind: 'chart', xType: 'time', series: [{ name: 'a', points: [[t0, Number.NaN]] }] }, 300, 120)).toBeNull();
    expect(lineGeometry({ kind: 'chart', xType: 'time', series: [] }, 300, 120)).toBeNull();
  });

  it('finds the nearest x for the hover readout and the value at or before it', () => {
    const g = lineGeometry(rising, 600, 200)!;
    expect(nearestIndex(g.xs, -50)).toBe(0);
    expect(nearestIndex(g.xs, 9999)).toBe(10);
    expect(nearestIndex(g.xs, g.xs[4].x + 1)).toBe(4);
    expect(nearestIndex([], 10)).toBe(-1);
    expect(valueAt([[1, 10], [3, 30]], 2)).toBe(10);
    expect(valueAt([[1, 10], [3, 30]], 3)).toBe(30);
    expect(valueAt([[1, 10]], 0)).toBeNull();
  });

  it('lays bars out around a shared zero and caps how many are shown', () => {
    const block: ChartBlock = { kind: 'chart', xType: 'category', style: 'bar', categories: ['Calls', 'Puts', 'Flat'], series: [{ name: 'gex', points: [[0, 10], [1, -5], [2, 0]] }] };
    const { bars, hidden } = barGeometry(block);
    expect(hidden).toBe(0);
    expect(bars.map((b) => b.label)).toEqual(['Calls', 'Puts', 'Flat']);
    const zero = (5 / 15) * 100;
    expect(bars[0].left).toBeCloseTo(zero);
    expect(bars[0].width).toBeCloseTo(100 - zero);
    expect(bars[1].left).toBeCloseTo(0);
    expect(bars[1].width).toBeCloseTo(zero);
    expect(bars[2].width).toBe(0);
    expect(barGeometry(block, 2)).toMatchObject({ hidden: 1 });
    expect(barGeometry({ kind: 'chart', xType: 'category', style: 'bar', series: [] })).toEqual({ bars: [], hidden: 0 });
  });
});
