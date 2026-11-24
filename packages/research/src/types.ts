/**
 * The research card contract.
 *
 * A card is one self-contained piece of research (a quote board, a yield
 * curve, an option chain). It fetches from a public source and returns
 * renderer-neutral blocks. The TUI, the CLI, the HTTP API and the MCP server
 * all run the same cards; only the rendering differs.
 */
import type { Http } from './http.js';

export type Cell = string | number | null | undefined;

/** How a value is printed. `signed*` formats are coloured green/red by sign. */
export type Format =
  | 'text'
  | 'num' // 1,234.56
  | 'int' // 1,235
  | 'compact' // 1.23B
  | 'usd' // $1,234.56
  | 'usdCompact' // $1.23B
  | 'pct' // 12.34%   (value is already in percent units)
  | 'signed' // +1.23
  | 'signedPct' // +1.23%
  | 'bp' // +12 bp  (value is in basis points)
  | 'date' // YYYY-MM-DD (value: ms epoch, ISO string or YYYY-MM-DD)
  | 'datetime';

export interface Column {
  key: string;
  label: string;
  format?: Format;
  /** Decimal places for numeric formats. */
  digits?: number;
  align?: 'left' | 'right';
  /** Hard cap on the printed width of this column. */
  maxWidth?: number;
}

export type Row = Record<string, Cell>;

export interface TableBlock {
  kind: 'table';
  title?: string;
  columns: Column[];
  rows: Row[];
  footnote?: string;
}

/** One line on a chart. For `xType: 'time'` x is ms since epoch; for 'category' x is the category index. */
export interface Series {
  name: string;
  points: [number, number][];
}

export interface ChartBlock {
  kind: 'chart';
  title?: string;
  /** 'time': x is ms epoch. 'number': x is a plain number (strike, tenor in years). 'category': x indexes `categories`. */
  xType: 'time' | 'number' | 'category';
  categories?: string[];
  series: Series[];
  /** 'line' (default) or 'bar' (one bar per x of the first series; category or number x). */
  style?: 'line' | 'bar';
  yFormat?: Format;
  yDigits?: number;
  /** Label for the x axis when xType is 'number' (e.g. "Strike", "Years"). */
  xLabel?: string;
}

export interface StatItem {
  label: string;
  value: Cell;
  format?: Format;
  digits?: number;
}

/** Key/value facts (a snapshot: market cap, P/E, 52-week range). */
export interface StatsBlock {
  kind: 'stats';
  title?: string;
  items: StatItem[];
}

export interface TextBlock {
  kind: 'text';
  title?: string;
  text: string;
}

export type Block = TableBlock | ChartBlock | StatsBlock | TextBlock;

export interface CardResult {
  blocks: Block[];
  /** The source that actually answered, when a card has a fallback chain (overrides CardDef.source). */
  source?: string;
  /** The original source page a person can open. */
  sourceUrl?: string;
  /** When the data is from (ISO date or datetime). */
  asOf?: string;
  /** Caveats: delayed quotes, a substituted provider, price vs total return. */
  notes?: string[];
}

/** Free API keys a card may need. Every dashboard's first tab works with none. */
export type KeyName = 'FRED' | 'EIA' | 'BLS' | 'CONGRESS';

export interface ParamSpec {
  /**
   * Shared names so one input drives every card on a dashboard:
   * `symbol`, `symbols` (comma list), `country` (ISO-2), `currency`, `range`
   * (1M 3M 6M 1Y 2Y 5Y 10Y MAX), `expiry` (YYYY-MM-DD), `series`, `query`.
   */
  name: string;
  label: string;
  default?: string;
  choices?: string[];
  /** Short hint shown in the prompt, e.g. "ticker, e.g. AAPL". */
  hint?: string;
}

export interface Ctx {
  http: Http;
  /** Returns the key, or undefined when the user has not configured one. */
  key(name: KeyName): string | undefined;
  now(): Date;
}

export interface CardDef {
  /** Stable id, `area.name`, e.g. `rates.us-curve`. Used by the CLI, API and MCP. */
  id: string;
  title: string;
  /** Default source label shown on the card header, e.g. "U.S. Treasury". */
  source: string;
  /** One line on what the card shows; used in the catalog and MCP tool output. */
  description?: string;
  params?: ParamSpec[];
  /** The card needs this free key; without it the card explains how to add one. */
  needsKey?: KeyName;
  run(ctx: Ctx, params: Record<string, string>): Promise<CardResult>;
}

export interface TabDef {
  id: string;
  title: string;
  /** Card ids, in display order. Keyless cards first. */
  cards: string[];
}

export interface DashboardDef {
  id: string;
  title: string;
  /** Sidebar group, e.g. "Equities", "Rates & Credit". */
  group: string;
  tabs: TabDef[];
}

/** A search hit: where to go and with which params. */
export interface SearchHit {
  kind: 'security' | 'dataset' | 'dashboard' | 'card';
  label: string;
  detail?: string;
  dashboard: string;
  tab?: string;
  params?: Record<string, string>;
}

export type SearchProvider = (ctx: Ctx, query: string) => Promise<SearchHit[]>;

/** What an area module exports. */
export interface AreaModule {
  cards: CardDef[];
  dashboards: DashboardDef[];
  search?: SearchProvider;
}

/** Thrown by a card whose key is missing; surfaces render the how-to instead of an error. */
export class MissingKeyError extends Error {
  constructor(public readonly keyName: KeyName) {
    super(`This card needs a free ${keyName} API key. Add one with: b1dz research keys set ${keyName} <key>`);
    this.name = 'MissingKeyError';
  }
}

/** Thrown when a public source fails; carries the source name for Data status. */
export class SourceError extends Error {
  constructor(
    public readonly source: string,
    message: string,
    public readonly status?: number,
  ) {
    super(`${source}: ${message}`);
    this.name = 'SourceError';
  }
}
