/**
 * Pure logic for /terminal: chart geometry, URL state, catalog helpers.
 * No React and no DOM here, so all of it is unit tested.
 */
import { formatValue, isoDate } from '@b1dz/research/format';
import type { ChartBlock, DashboardDef, Format } from '@b1dz/research/types';

export interface CatalogParam {
  name: string;
  label: string;
  default?: string;
  choices?: string[];
  hint?: string;
}

export interface CatalogCard {
  id: string;
  title: string;
  source: string;
  description?: string;
  needsKey?: string;
  params: CatalogParam[];
}

export interface Catalog {
  dashboards: DashboardDef[];
  cards: CatalogCard[];
}

export const RANGES = ['1M', '3M', '6M', '1Y', '2Y', '5Y', '10Y', 'MAX'];
/** The input the `s` key focuses, in order of preference. */
export const PRIMARY_PARAMS = ['symbol', 'symbols', 'country', 'query', 'series', 'currency'];
export const SERIES_COLORS = ['#34d399', '#fbbf24', '#f472b6', '#60a5fa', '#f87171', '#a78bfa', '#e4e4e7', '#71717a'];

// ---- catalog ---------------------------------------------------------------

/** Dashboards grouped for the sidebar, in catalog order. */
export function groupDashboards(dashboards: DashboardDef[]): { group: string; items: DashboardDef[] }[] {
  const out: { group: string; items: DashboardDef[] }[] = [];
  for (const d of dashboards) {
    const last = out[out.length - 1];
    if (last && last.group === d.group) last.items.push(d);
    else out.push({ group: d.group, items: [d] });
  }
  return out;
}

/** Params of every card on a tab, first definition of each name wins. */
export function tabParams(cardIds: string[], cards: Map<string, CatalogCard>): CatalogParam[] {
  const seen = new Map<string, CatalogParam>();
  for (const id of cardIds) for (const p of cards.get(id)?.params ?? []) if (!seen.has(p.name)) seen.set(p.name, p);
  return [...seen.values()];
}

/** What to send for one card: only the params it declares, defaults left to the server. */
export function paramsForCard(card: CatalogCard | undefined, given: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of card?.params ?? []) {
    const v = given[p.name]?.trim();
    if (v) out[p.name] = v;
  }
  return out;
}

export function cardKey(id: string, params: Record<string, string>): string {
  return `${id}?${Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')}`;
}

export function cardUrl(id: string, params: Record<string, string>, format?: 'csv' | 'text'): string {
  const q = new URLSearchParams(params);
  if (format) q.set('format', format);
  const qs = q.toString();
  return `/api/research/card/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
}

/** Catalog matches for the search box when signed out, or before the server answers. */
export function localSearch(catalog: Catalog, query: string, limit = 12): { label: string; detail: string; dashboard: string; tab?: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: { label: string; detail: string; dashboard: string; tab?: string }[] = [];
  const byId = new Map(catalog.cards.map((c) => [c.id, c]));
  for (const d of catalog.dashboards) {
    if (d.title.toLowerCase().includes(q) || d.id.includes(q)) out.push({ label: d.title, detail: d.group, dashboard: d.id });
    for (const t of d.tabs) {
      if (t.title.toLowerCase().includes(q)) out.push({ label: `${d.title} › ${t.title}`, detail: d.group, dashboard: d.id, tab: t.id });
      for (const id of t.cards) {
        const c = byId.get(id);
        if (c && (c.title.toLowerCase().includes(q) || c.id.includes(q))) out.push({ label: c.title, detail: `${d.title} › ${t.title}`, dashboard: d.id, tab: t.id });
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// ---- watchlist panel -------------------------------------------------------

export interface WatchQuote {
  last: number | null;
  /** Day change in percent. */
  day: number | null;
}

/** symbol -> last and day change, read from a returns-board table (the Watchlist card). */
export function watchQuotes(blocks: { kind: string; rows?: Record<string, unknown>[] }[] | undefined): Record<string, WatchQuote> {
  const out: Record<string, WatchQuote> = {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  for (const b of blocks ?? []) {
    if (b.kind !== 'table') continue;
    for (const row of b.rows ?? []) {
      const symbol = typeof row.symbol === 'string' ? row.symbol.toUpperCase() : '';
      if (symbol) out[symbol] = { last: num(row.last), day: num(row.day) };
    }
  }
  return out;
}

/** Split a list into runs of at most `size` (the Watchlist card takes 40 symbols a call). */
export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ---- URL state -------------------------------------------------------------

export interface View {
  dashboard: string;
  tab: string;
  params: Record<string, string>;
}

/** /terminal?d=company&t=overview&symbol=NVDA  ->  a view. Unknown ids fall back to the first. */
export function viewFromSearch(search: string, catalog: Catalog, fallback?: Partial<View>): View {
  const q = new URLSearchParams(search);
  const want = q.get('d') ?? fallback?.dashboard ?? '';
  const d = catalog.dashboards.find((x) => x.id === want) ?? catalog.dashboards[0];
  if (!d) return { dashboard: '', tab: '', params: {} };
  const wantTab = q.get('t') ?? (d.id === fallback?.dashboard ? fallback?.tab : undefined) ?? '';
  const t = d.tabs.find((x) => x.id === wantTab) ?? d.tabs[0];
  const params: Record<string, string> = {};
  for (const [k, v] of q) if (k !== 'd' && k !== 't' && v) params[k] = v.slice(0, 400);
  return { dashboard: d.id, tab: t?.id ?? '', params };
}

export function searchFromView(view: View): string {
  const q = new URLSearchParams();
  q.set('d', view.dashboard);
  if (view.tab) q.set('t', view.tab);
  for (const [k, v] of Object.entries(view.params)) if (v) q.set(k, v);
  return `?${q.toString()}`;
}

// ---- chart geometry --------------------------------------------------------

export interface ChartGeometry {
  width: number;
  height: number;
  plot: { left: number; top: number; right: number; bottom: number };
  lines: { name: string; color: string; path: string; last: number | null }[];
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[];
  /** Zero line y, when zero is inside the range. */
  zeroY: number | null;
  /** Distinct x values with their pixel x, for the hover readout. */
  xs: { value: number; x: number; label: string }[];
  domain: { xMin: number; xMax: number; yMin: number; yMax: number };
}

export function axisLabel(v: number, format: Format | undefined, digits: number | undefined): string {
  if (format && format !== 'num') return formatValue(v, format, digits);
  const a = Math.abs(v);
  if (a >= 100_000) return formatValue(v, 'compact', 1);
  return formatValue(v, 'num', digits ?? (a >= 1000 ? 0 : 2));
}

export function xLabel(block: ChartBlock, x: number): string {
  if (block.xType === 'time') return isoDate(x);
  if (block.xType === 'category') return block.categories?.[Math.round(x)] ?? String(x);
  return formatValue(x, 'num', Number.isInteger(x) ? 0 : 2);
}

/** SVG paths and ticks for a line chart. Returns null when there is nothing to draw. */
export function lineGeometry(block: ChartBlock, width: number, height: number): ChartGeometry | null {
  const series = block.series
    .map((s) => ({ name: s.name, points: s.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).sort((a, b) => a[0] - b[0]) }))
    .filter((s) => s.points.length);
  if (!series.length) return null;
  const all = series.flatMap((s) => s.points);
  let xMin = Math.min(...all.map((p) => p[0]));
  let xMax = Math.max(...all.map((p) => p[0]));
  let yMin = Math.min(...all.map((p) => p[1]));
  let yMax = Math.max(...all.map((p) => p[1]));
  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  if (yMin === yMax) {
    const d = Math.abs(yMin) * 0.05 || 1;
    yMin -= d;
    yMax += d;
  }
  const pad = (yMax - yMin) * 0.05;
  yMin -= pad;
  yMax += pad;

  const topLabel = axisLabel(yMax, block.yFormat, block.yDigits);
  const bottomLabel = axisLabel(yMin, block.yFormat, block.yDigits);
  const plot = { left: Math.max(topLabel.length, bottomLabel.length) * 6.6 + 10, top: 6, right: width - 8, bottom: height - 18 };
  const px = (x: number) => plot.left + ((x - xMin) / (xMax - xMin)) * (plot.right - plot.left);
  const py = (y: number) => plot.top + (1 - (y - yMin) / (yMax - yMin)) * (plot.bottom - plot.top);
  const r = (n: number) => Math.round(n * 10) / 10;

  const lines = series.map((s, i) => ({
    name: s.name,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    path: s.points.map(([x, y], j) => `${j ? 'L' : 'M'}${r(px(x))} ${r(py(y))}`).join(''),
    last: s.points[s.points.length - 1]?.[1] ?? null,
  }));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = yMax - f * (yMax - yMin);
    return { y: r(py(v)), label: axisLabel(v, block.yFormat, block.yDigits) };
  });
  const mid = (xMin + xMax) / 2;
  const xTicks: ChartGeometry['xTicks'] = [
    { x: r(px(xMin)), label: xLabel(block, xMin), anchor: 'start' },
    { x: r(px(mid)), label: block.xType === 'number' && block.xLabel ? block.xLabel : xLabel(block, mid), anchor: 'middle' },
    { x: r(px(xMax)), label: xLabel(block, xMax), anchor: 'end' },
  ];
  const distinct = [...new Set(all.map((p) => p[0]))].sort((a, b) => a - b);
  return {
    width,
    height,
    plot,
    lines,
    yTicks,
    xTicks,
    zeroY: yMin < 0 && yMax > 0 ? r(py(0)) : null,
    xs: distinct.map((value) => ({ value, x: r(px(value)), label: xLabel(block, value) })),
    domain: { xMin, xMax, yMin, yMax },
  };
}

/** Index of the x value nearest to pixel `x` (binary search over sorted xs). */
export function nearestIndex(xs: { x: number }[], x: number): number {
  if (!xs.length) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (xs[m].x <= x) lo = m;
    else hi = m;
  }
  return Math.abs(xs[lo].x - x) <= Math.abs(xs[hi].x - x) ? lo : hi;
}

/** Value of a series at an x, or the latest value at or before it. */
export function valueAt(points: [number, number][], x: number): number | null {
  let out: number | null = null;
  for (const [px, py] of points) {
    if (px > x) break;
    out = py;
  }
  return out;
}

export interface Bar {
  label: string;
  value: number;
  text: string;
  /** Percent offsets inside the track. */
  left: number;
  width: number;
}

/** Horizontal bars around a shared zero for the first series of a bar chart. */
export function barGeometry(block: ChartBlock, max = 60): { bars: Bar[]; hidden: number } {
  const pts = (block.series[0]?.points ?? []).filter(([, y]) => Number.isFinite(y));
  const shown = pts.slice(0, max);
  if (!shown.length) return { bars: [], hidden: 0 };
  const lo = Math.min(0, ...shown.map((p) => p[1]));
  const hi = Math.max(0, ...shown.map((p) => p[1]));
  const span = hi - lo || 1;
  const zero = ((0 - lo) / span) * 100;
  return {
    bars: shown.map(([x, y]) => {
      const at = ((y - lo) / span) * 100;
      return {
        label: xLabel(block, x),
        value: y,
        text: formatValue(y, block.yFormat ?? 'num', block.yDigits),
        left: Math.min(zero, at),
        width: Math.max(y === 0 ? 0 : 0.6, Math.abs(at - zero)),
      };
    }),
    hidden: pts.length - shown.length,
  };
}
