/** CFTC Commitments of Traders positioning cards for currencies, commodities and agriculture. */
import { mapLimit, rangeStart } from '../../lib/market.js';
import { SourceError, type CardDef, type Row } from '../../types.js';
import { COT_SOURCE, COT_URL, cotNetChange, cotNetSeries, getCot, type CotData, type CotReport } from '../derivatives/cot.js';
import { percentile, toRange } from './util.js';

export interface CotMarket {
  /** Value of the `symbol` param that selects this market for the history chart. */
  key: string;
  label: string;
  /** CFTC contract market code. */
  code: string;
}

interface Def {
  id: string;
  title: string;
  description: string;
  report: CotReport;
  markets: CotMarket[];
  /** The trader group the card is about, and a second one shown beside it. */
  primary: { key: string; label: string };
  secondary: { key: string; label: string };
  note: string;
}

/** Five years of weekly reports for the chart; the percentile uses the latest three. */
const WEEKS = 261;
const PCTILE_WEEKS = 157;

/** Where the latest net position sits in its own history, 0 (most short) to 100 (most long). */
export function netPercentile(data: Pick<CotData, 'weeks'>, key: string): number | null {
  const nets = data.weeks.slice(0, PCTILE_WEEKS).flatMap((w) => (w.positions[key] ? [w.positions[key].net] : []));
  return nets.length > 10 ? percentile(nets, nets[0]) : null;
}

export function positioningCard(def: Def): CardDef {
  return {
    id: def.id,
    title: def.title,
    source: COT_SOURCE,
    description: def.description,
    params: [
      { name: 'symbol', label: 'Market', default: def.markets[0].key, choices: def.markets.map((m) => m.key), hint: 'market for the history chart' },
      { name: 'range', label: 'Range', default: '2Y', choices: ['6M', '1Y', '2Y', '5Y'] },
    ],
    async run(ctx, params) {
      const got = await mapLimit(def.markets, 3, async (m) => {
        try {
          return { m, data: await getCot(ctx, { market: m.code, report: def.report, weeks: WEEKS }) };
        } catch (e) {
          return { m, error: (e as Error).message };
        }
      });
      const ok = got.filter((g): g is { m: CotMarket; data: CotData } => 'data' in g);
      const failed = got.filter((g): g is { m: CotMarket; error: string } => 'error' in g);
      if (!ok.length) throw new SourceError(COT_SOURCE, failed[0]?.error.replace(/^[^:]+:\s*/, '') ?? 'no reports returned');
      const rows: Row[] = ok.map(({ m, data }) => {
        const w = data.weeks[0];
        const p = w.positions[def.primary.key];
        const s = w.positions[def.secondary.key];
        return {
          name: m.label,
          contract: data.market,
          net: p?.net,
          chg: cotNetChange(data.weeks, def.primary.key),
          long: p?.long,
          short: p?.short,
          pctile: netPercentile(data, def.primary.key),
          other: s?.net,
          otherChg: cotNetChange(data.weeks, def.secondary.key),
          oi: w.openInterest,
          date: w.date,
        };
      });
      const want = (params.symbol ?? '').trim().toLowerCase();
      const pick = ok.find((g) => g.m.key.toLowerCase() === want) ?? ok[0];
      const from = rangeStart(toRange(params.range, '2Y'), ctx.now()).getTime();
      const line = (key: string): [number, number][] => cotNetSeries(pick.data.weeks, key).filter((p) => p[0] >= from);
      return {
        blocks: [
          {
            kind: 'table',
            columns: [
              { key: 'name', label: 'Market' },
              { key: 'net', label: `${def.primary.label} net`, format: 'int' },
              { key: 'chg', label: 'Week chg', format: 'signed', digits: 0 },
              { key: 'long', label: 'Long', format: 'int' },
              { key: 'short', label: 'Short', format: 'int' },
              { key: 'pctile', label: '3Y pctile', format: 'num', digits: 0 },
              { key: 'other', label: `${def.secondary.label} net`, format: 'int' },
              { key: 'oi', label: 'Open interest', format: 'int' },
              { key: 'date', label: 'Report', format: 'date' },
            ],
            rows,
            footnote: 'Contracts, futures only. 3Y pctile: where the net position sits in its last three years, 0 = most short, 100 = most long.',
          },
          {
            kind: 'chart',
            title: `${pick.m.label} (${pick.data.marketAndExchange}): net position, contracts`,
            xType: 'time',
            yFormat: 'int',
            series: [
              { name: def.primary.label, points: line(def.primary.key) },
              { name: def.secondary.label, points: line(def.secondary.key) },
            ],
          },
        ],
        sourceUrl: COT_URL,
        asOf: ok.map((g) => g.data.weeks[0].date).sort().pop(),
        notes: [def.note, ...(failed.length ? [`No report for: ${failed.map((f) => `${f.m.label} (${f.error.replace(/^[^:]+:\s*/, '')})`).join('; ')}`] : [])],
      };
    },
  };
}

const TFF_NOTE =
  'CFTC Traders in Financial Futures report: positions as of Tuesday, published Friday. Leveraged funds are hedge funds and CTAs; asset managers are institutional investors. A positive net position is long the currency against the dollar.';
const DISAGG_NOTE =
  'CFTC Disaggregated Commitments of Traders: positions as of Tuesday, published Friday. Managed money is hedge funds and CTAs; producers and merchants are the commercial hedgers on the other side.';

export const fxPositioning = positioningCard({
  id: 'fx.positioning',
  title: 'Currency futures positioning (CFTC)',
  description: 'Leveraged-fund and asset-manager net positions in CME currency futures, with the weekly change and history.',
  report: 'financial',
  markets: [
    { key: 'EUR', label: 'Euro', code: '099741' },
    { key: 'JPY', label: 'Japanese yen', code: '097741' },
    { key: 'GBP', label: 'British pound', code: '096742' },
    { key: 'CHF', label: 'Swiss franc', code: '092741' },
    { key: 'CAD', label: 'Canadian dollar', code: '090741' },
    { key: 'AUD', label: 'Australian dollar', code: '232741' },
    { key: 'NZD', label: 'New Zealand dollar', code: '112741' },
    { key: 'MXN', label: 'Mexican peso', code: '095741' },
  ],
  primary: { key: 'leveraged', label: 'Leveraged funds' },
  secondary: { key: 'assetManager', label: 'Asset managers' },
  note: TFF_NOTE,
});

export const commodityPositioning = positioningCard({
  id: 'commodities.positioning',
  title: 'Commodity futures positioning (CFTC)',
  description: 'Managed-money net positions in energy, metals and grain futures, with the weekly change and history.',
  report: 'disaggregated',
  markets: [
    { key: 'crude', label: 'WTI crude oil', code: '067651' },
    { key: 'natgas', label: 'Natural gas', code: '023651' },
    { key: 'gold', label: 'Gold', code: '088691' },
    { key: 'silver', label: 'Silver', code: '084691' },
    { key: 'copper', label: 'Copper', code: '085692' },
    { key: 'corn', label: 'Corn', code: '002602' },
    { key: 'wheat', label: 'Wheat (Chicago SRW)', code: '001602' },
    { key: 'soybeans', label: 'Soybeans', code: '005602' },
  ],
  primary: { key: 'managedMoney', label: 'Managed money' },
  secondary: { key: 'producer', label: 'Producers' },
  note: DISAGG_NOTE,
});

export const agriPositioning = positioningCard({
  id: 'agri.positioning',
  title: 'Agricultural futures positioning (CFTC)',
  description: 'Managed-money net positions in grain, soft and livestock futures, with the weekly change and history.',
  report: 'disaggregated',
  markets: [
    { key: 'corn', label: 'Corn', code: '002602' },
    { key: 'wheat', label: 'Wheat (Chicago SRW)', code: '001602' },
    { key: 'soybeans', label: 'Soybeans', code: '005602' },
    { key: 'sugar', label: 'Sugar No. 11', code: '080732' },
    { key: 'coffee', label: 'Coffee C', code: '083731' },
    { key: 'cotton', label: 'Cotton No. 2', code: '033661' },
    { key: 'cattle', label: 'Live cattle', code: '057642' },
    { key: 'hogs', label: 'Lean hogs', code: '054642' },
  ],
  primary: { key: 'managedMoney', label: 'Managed money' },
  secondary: { key: 'producer', label: 'Producers' },
  note: DISAGG_NOTE,
});
