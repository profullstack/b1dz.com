/** Currencies > Board, Strength and Cross rates. */
import { rangeStart } from '../../lib/market.js';
import type { CardDef, Column, Row } from '../../types.js';
import {
  CURRENCY_NAMES,
  crossChange,
  crossRate,
  crossSeries,
  currencyStrength,
  FX_NOTE,
  FX_SOURCE,
  FX_URL,
  fxPanel,
  MAJORS,
  marketPair,
  REGIONS,
  strengthSeries,
  type FxPanel,
} from './fx-data.js';
import { DAY, monthsBack, monthStartBack, pointReturns, rangeParam, RETURN_COLUMNS_DAILY, toRange, ymd } from './util.js';

/** Thirteen months of fixings: enough for every horizon on the board. */
const boardPanel = (ctx: Parameters<CardDef['run']>[0]): Promise<FxPanel> => fxPanel(ctx, monthStartBack(ctx.now(), 13));

const asOf = (panel: FxPanel): string => ymd(panel.dates[panel.dates.length - 1]);

const board: CardDef = {
  id: 'fx.board',
  title: 'Currency board',
  source: FX_SOURCE,
  description: 'Spot reference rates by region in market quoting convention, with day change and returns.',
  async run(ctx) {
    const panel = await boardPanel(ctx);
    const rows: Row[] = [];
    for (const region of REGIONS) {
      for (const ccy of region.currencies) {
        const { pair, inverted } = marketPair(ccy);
        const series = inverted ? crossSeries(panel, ccy, 'USD') : crossSeries(panel, 'USD', ccy);
        if (!series.length) continue;
        rows.push({ region: region.name, pair, name: CURRENCY_NAMES[ccy] ?? ccy, ...pointReturns(series) });
      }
    }
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'region', label: 'Region' },
            { key: 'pair', label: 'Pair' },
            { key: 'name', label: 'Currency', maxWidth: 20 },
            { key: 'last', label: 'Rate', format: 'num', digits: 4 },
            ...RETURN_COLUMNS_DAILY,
          ],
          rows,
          footnote: 'Changes are in the pair as quoted: EURUSD up means a stronger euro, USDJPY up means a weaker yen.',
        },
      ],
      sourceUrl: FX_URL,
      asOf: asOf(panel),
      notes: [FX_NOTE],
    };
  },
};

const ranking: CardDef = {
  id: 'fx.usd-ranking',
  title: 'Currencies ranked against the U.S. dollar',
  source: FX_SOURCE,
  description: 'Every published currency ranked by its gain or loss against the dollar over the chosen horizon.',
  params: [rangeParam('1M', ['1M', '3M', '6M', '1Y', '2Y', '5Y'])],
  async run(ctx, params) {
    const range = toRange(params.range, '1M');
    const from = rangeStart(range, ctx.now());
    const panel = await fxPanel(ctx, ymd(from.getTime() - 10 * DAY));
    const end = panel.dates[panel.dates.length - 1];
    const ranked = Object.keys(panel.perUsd)
      .filter((c) => c !== 'USD')
      .map((c) => ({ c, v: crossChange(panel, c, 'USD', from.getTime()), day: crossChange(panel, c, 'USD', end - 1), week: crossChange(panel, c, 'USD', end - 7 * DAY) }))
      .filter((x): x is { c: string; v: number; day: number | null; week: number | null } => x.v !== null)
      .sort((a, b) => b.v - a.v);
    return {
      blocks: [
        {
          kind: 'chart',
          title: `Change against the dollar over ${range}, percent`,
          xType: 'category',
          style: 'bar',
          categories: ranked.map((r) => r.c),
          yFormat: 'signedPct',
          series: [{ name: range, points: ranked.map((r, i) => [i, r.v] as [number, number]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'c', label: 'Code' },
            { key: 'name', label: 'Currency', maxWidth: 22 },
            { key: 'v', label: range, format: 'signedPct' },
            { key: 'week', label: '1W', format: 'signedPct' },
            { key: 'day', label: 'Day', format: 'signedPct' },
          ],
          rows: ranked.map((r, i) => ({ rank: i + 1, c: r.c, name: CURRENCY_NAMES[r.c] ?? r.c, v: r.v, week: r.week, day: r.day })),
          footnote: 'Positive: the currency gained against the dollar.',
        },
      ],
      sourceUrl: FX_URL,
      asOf: ymd(end),
      notes: [FX_NOTE],
    };
  },
};

const strength: CardDef = {
  id: 'fx.strength',
  title: 'Currency strength: the eight majors',
  source: FX_SOURCE,
  description: "Each major currency's average move against the other seven over the chosen horizon, beside its move against the dollar alone.",
  params: [rangeParam('1M', ['1M', '3M', '6M', '1Y', '2Y', '5Y'])],
  async run(ctx, params) {
    const range = toRange(params.range, '1M');
    const from = rangeStart(range, ctx.now()).getTime();
    const panel = await fxPanel(ctx, ymd(from - 10 * DAY));
    const table = currencyStrength(panel, MAJORS, from);
    return {
      blocks: [
        {
          kind: 'chart',
          title: `Average move against the other seven since ${ymd(from)}, percent`,
          xType: 'time',
          yFormat: 'signedPct',
          yDigits: 1,
          series: table.map((s) => ({ name: s.currency, points: strengthSeries(panel, MAJORS, s.currency, from) })),
        },
        {
          kind: 'table',
          columns: [
            { key: 'currency', label: 'Currency' },
            { key: 'name', label: 'Name' },
            { key: 'average', label: 'Avg vs other 7', format: 'signedPct' },
            { key: 'vsUsd', label: 'vs USD only', format: 'signedPct' },
            { key: 'best', label: 'Strongest against' },
            { key: 'worst', label: 'Weakest against' },
          ],
          rows: table.map((s) => ({ currency: s.currency, name: CURRENCY_NAMES[s.currency], average: s.average, vsUsd: s.vsUsd, best: s.strongestAgainst, worst: s.weakestAgainst })),
          footnote: 'A currency that only moved against the dollar shows a large "vs USD" and a small average: that is a dollar story, not its own.',
        },
      ],
      sourceUrl: FX_URL,
      asOf: asOf(panel),
      notes: [`Equal-weighted average of the seven bilateral percent changes over ${range}. ${FX_NOTE}`],
    };
  },
};

const crossRates: CardDef = {
  id: 'fx.cross-rates',
  title: 'Cross rates: the majors',
  source: FX_SOURCE,
  description: 'Cross-rate matrix for the eight major currencies, with one-month changes.',
  async run(ctx) {
    const panel = await boardPanel(ctx);
    const end = panel.dates[panel.dates.length - 1];
    const cols = (format: Column['format'], digits: number): Column[] => [
      { key: 'base', label: '1 unit of' },
      ...MAJORS.map((q) => ({ key: q, label: q, format, digits }) satisfies Column),
    ];
    const rates: Row[] = MAJORS.map((b) => {
      const row: Row = { base: b };
      for (const q of MAJORS) row[q] = b === q ? null : crossRate(panel, b, q);
      return row;
    });
    const moves: Row[] = MAJORS.map((b) => {
      const row: Row = { base: b };
      for (const q of MAJORS) row[q] = b === q ? null : crossChange(panel, b, q, monthsBack(end, 1));
      return row;
    });
    return {
      blocks: [
        { kind: 'table', title: 'Price of one unit of the row currency in the column currency', columns: cols('num', 4), rows: rates },
        { kind: 'table', title: 'One-month change, percent (positive: the row currency gained)', columns: cols('signedPct', 1), rows: moves },
      ],
      sourceUrl: FX_URL,
      asOf: ymd(end),
      notes: [FX_NOTE],
    };
  },
};

export const fxMarketCards: CardDef[] = [board, ranking];
export const fxStrengthCards: CardDef[] = [strength];
export const fxCrossCards: CardDef[] = [crossRates];
