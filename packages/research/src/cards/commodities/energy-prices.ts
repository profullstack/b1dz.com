/** Energy > Overview: crude benchmarks, refining margins, gas benchmarks, uranium. */
import { rangeStart } from '../../lib/market.js';
import type { Block, CardDef, Row } from '../../types.js';
import { alignPoints, EIA, eiaNotes, eiaPoints } from './eia.js';
import { GAS, gasPrices, petroleumSpot, SPOT } from './energy-data.js';
import { IMF, PCPS, PCPS_URL, pcpsSeries } from './imf.js';
import { mean, monthStartBack, pointReturns, rangeParam, RETURN_COLUMNS_DAILY, since, toRange, valueAt, ymd, monthsBack, DAY, type Point } from './util.js';

const SPOT_URL = 'https://www.eia.gov/dnav/pet/pet_pri_spt_s1_d.htm';
const SHORT_RANGES = ['1M', '3M', '6M', '1Y', '2Y'] as const;

const last = (pts: Point[]): Point | undefined => pts[pts.length - 1];

const crudeSpot: CardDef = {
  id: 'energy.crude-spot',
  title: 'Crude oil: WTI, Brent and the spread',
  source: EIA,
  description: 'Daily WTI and Brent spot prices and the Brent minus WTI spread.',
  params: [rangeParam('1Y', [...SHORT_RANGES])],
  async run(ctx, params) {
    const rows = await petroleumSpot(ctx);
    const wti = eiaPoints(rows, 'series', SPOT.wti.id);
    const brent = eiaPoints(rows, 'series', SPOT.brent.id);
    const spread: Point[] = alignPoints([brent, wti]).map((p) => [p.t, p.v[0] - p.v[1]]);
    const from = rangeStart(toRange(params.range), ctx.now()).getTime();
    const w = last(wti);
    const b = last(brent);
    const s = last(spread);
    const board: Row[] = [
      { name: 'WTI, Cushing', ...pointReturns(wti) },
      { name: 'Brent, Europe', ...pointReturns(brent) },
    ];
    const blocks: Block[] = [
      {
        kind: 'stats',
        items: [
          { label: 'WTI (USD/bbl)', value: w?.[1], format: 'num', digits: 2 },
          { label: 'Brent (USD/bbl)', value: b?.[1], format: 'num', digits: 2 },
          { label: 'Brent minus WTI', value: s?.[1], format: 'signed', digits: 2 },
          { label: 'Spread, 1Y average', value: mean(since(spread, (s?.[0] ?? 0) - 365 * DAY).map((p) => p[1])), format: 'signed', digits: 2 },
        ],
      },
      { kind: 'chart', title: 'Spot price, USD per barrel', xType: 'time', yFormat: 'num', yDigits: 2, series: [{ name: 'WTI', points: since(wti, from) }, { name: 'Brent', points: since(brent, from) }] },
      { kind: 'chart', title: 'Brent minus WTI, USD per barrel', xType: 'time', yFormat: 'signed', yDigits: 2, series: [{ name: 'Spread', points: since(spread, from) }] },
      { kind: 'table', columns: [{ key: 'name', label: 'Benchmark' }, { key: 'last', label: 'Last', format: 'num', digits: 2 }, ...RETURN_COLUMNS_DAILY], rows: board },
    ];
    return {
      blocks,
      sourceUrl: SPOT_URL,
      asOf: w ? ymd(w[0]) : undefined,
      notes: ['Spot assessments published by the EIA with a lag of several days; not live quotes.', ...eiaNotes(ctx)],
    };
  },
};

/** Refining margins in USD per barrel from product prices in USD per gallon and crude in USD per barrel. */
export function crackSpreads(crude: number, gasoline: number, distillate: number): { gasoline: number; distillate: number; c321: number } {
  return {
    gasoline: gasoline * 42 - crude,
    distillate: distillate * 42 - crude,
    c321: ((2 * gasoline + distillate) * 42) / 3 - crude,
  };
}

const cracks: CardDef = {
  id: 'energy.crack-spreads',
  title: 'Refining margins: crack spreads',
  source: EIA,
  description: '3-2-1, gasoline and diesel crack spreads computed from EIA spot prices (New York Harbor products against WTI).',
  params: [rangeParam('1Y', [...SHORT_RANGES])],
  async run(ctx, params) {
    const rows = await petroleumSpot(ctx);
    const aligned = alignPoints([eiaPoints(rows, 'series', SPOT.wti.id), eiaPoints(rows, 'series', SPOT.gasoline.id), eiaPoints(rows, 'series', SPOT.ulsd.id)]);
    const calc = aligned.map((p) => ({ t: p.t, ...crackSpreads(p.v[0], p.v[1], p.v[2]) }));
    const c321: Point[] = calc.map((c) => [c.t, c.c321]);
    const gas: Point[] = calc.map((c) => [c.t, c.gasoline]);
    const dist: Point[] = calc.map((c) => [c.t, c.distillate]);
    const from = rangeStart(toRange(params.range), ctx.now()).getTime();
    const end = last(c321)?.[0] ?? 0;
    const row = (name: string, pts: Point[]): Row => ({
      name,
      last: last(pts)?.[1],
      w1: valueAt(pts, end - 7 * DAY),
      m1: valueAt(pts, monthsBack(end, 1)),
      y1: valueAt(pts, monthsBack(end, 12)),
      avg: mean(since(pts, end - 365 * DAY).map((p) => p[1])),
    });
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Crack spreads, USD per barrel',
          xType: 'time',
          yFormat: 'num',
          yDigits: 1,
          series: [
            { name: '3-2-1', points: since(c321, from) },
            { name: 'Gasoline', points: since(gas, from) },
            { name: 'Diesel', points: since(dist, from) },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Spread (USD/bbl)' },
            { key: 'last', label: 'Last', format: 'num', digits: 2 },
            { key: 'w1', label: '1W ago', format: 'num', digits: 2 },
            { key: 'm1', label: '1M ago', format: 'num', digits: 2 },
            { key: 'y1', label: '1Y ago', format: 'num', digits: 2 },
            { key: 'avg', label: '1Y average', format: 'num', digits: 2 },
          ],
          rows: [row('3-2-1 crack', c321), row('Gasoline crack', gas), row('Diesel crack', dist)],
        },
      ],
      sourceUrl: SPOT_URL,
      asOf: end ? ymd(end) : undefined,
      notes: [
        'Computed here: product price per gallon times 42, less WTI per barrel. 3-2-1 is two barrels of gasoline and one of diesel per three of crude. Products are New York Harbor conventional gasoline and ultra-low-sulfur diesel.',
        ...eiaNotes(ctx),
      ],
    };
  },
};

const henryHub: CardDef = {
  id: 'energy.henry-hub',
  title: 'U.S. natural gas: Henry Hub',
  source: EIA,
  description: 'Daily Henry Hub spot price with returns.',
  params: [rangeParam('1Y', [...SHORT_RANGES])],
  async run(ctx, params) {
    const rows = await gasPrices(ctx);
    const hh = eiaPoints(rows, 'series', GAS.spot.id);
    const from = rangeStart(toRange(params.range), ctx.now()).getTime();
    const r = pointReturns(hh);
    const window = since(hh, (r.asOf ?? 0) - 365 * DAY).map((p) => p[1]);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Henry Hub (USD/MMBtu)', value: r.last, format: 'num', digits: 2 },
            { label: 'Day', value: r.prev, format: 'signedPct' },
            { label: '1M', value: r.m1, format: 'signedPct' },
            { label: '1Y', value: r.y1, format: 'signedPct' },
            { label: '1Y low', value: window.length ? Math.min(...window) : null, format: 'num', digits: 2 },
            { label: '1Y high', value: window.length ? Math.max(...window) : null, format: 'num', digits: 2 },
          ],
        },
        { kind: 'chart', title: 'Henry Hub spot, USD per MMBtu', xType: 'time', yFormat: 'num', yDigits: 2, series: [{ name: 'Henry Hub', points: since(hh, from) }] },
      ],
      sourceUrl: 'https://www.eia.gov/dnav/ng/ng_pri_fut_s1_d.htm',
      asOf: r.asOf ? ymd(r.asOf) : undefined,
      notes: ['Spot assessment published by the EIA with a lag of several days.', ...eiaNotes(ctx)],
    };
  },
};

const globalGas: CardDef = {
  id: 'energy.global-gas',
  title: 'Gas benchmarks: Henry Hub, Europe (TTF) and Asia LNG',
  source: IMF,
  description: 'Monthly average gas prices in the U.S., Europe and Asia in the same units, and the Europe minus U.S. spread.',
  params: [rangeParam('5Y', ['1Y', '2Y', '5Y', '10Y'])],
  async run(ctx, params) {
    const range = toRange(params.range, '5Y');
    const months = { '1Y': 13, '2Y': 25, '5Y': 61, '10Y': 121 }[range as '1Y'] ?? 61;
    const got = await pcpsSeries(ctx, ['PNGASUS', 'PNGASEU', 'PNGASJP'], monthStartBack(ctx.now(), months).slice(0, 7));
    const us = got.get('PNGASUS') ?? [];
    const eu = got.get('PNGASEU') ?? [];
    const jp = got.get('PNGASJP') ?? [];
    const spread: Point[] = alignPoints([eu, us]).map((p) => [p.t, p.v[0] - p.v[1]]);
    const rowsOut: Row[] = [
      { name: PCPS.PNGASUS.name, ...pointReturns(us) },
      { name: PCPS.PNGASEU.name, ...pointReturns(eu) },
      { name: PCPS.PNGASJP.name, ...pointReturns(jp) },
    ];
    const end = last(eu)?.[0];
    const ratio = last(us) && last(eu) ? (last(eu) as Point)[1] / (last(us) as Point)[1] : null;
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Europe minus U.S. (USD/MMBtu)', value: last(spread)?.[1], format: 'signed', digits: 2 },
            { label: 'Europe as a multiple of U.S.', value: ratio, format: 'num', digits: 1 },
          ],
        },
        {
          kind: 'chart',
          title: 'Monthly average, USD per MMBtu',
          xType: 'time',
          yFormat: 'num',
          yDigits: 1,
          series: [
            { name: 'Henry Hub', points: us },
            { name: 'Europe (TTF)', points: eu },
            { name: 'Japan / Korea LNG', points: jp },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Benchmark (USD/MMBtu)' },
            { key: 'last', label: 'Month avg', format: 'num', digits: 2 },
            { key: 'prev', label: '1M', format: 'signedPct' },
            { key: 'm3', label: '3M', format: 'signedPct' },
            { key: 'y1', label: '1Y', format: 'signedPct' },
          ],
          rows: rowsOut,
        },
      ],
      sourceUrl: PCPS_URL,
      asOf: end ? ymd(end).slice(0, 7) : undefined,
      notes: ['Monthly averages from the IMF Primary Commodity Price System, all converted by the IMF to U.S. dollars per million Btu. Updated monthly, about two weeks after month end.'],
    };
  },
};

const uranium: CardDef = {
  id: 'energy.uranium',
  title: 'Uranium and coal',
  source: IMF,
  description: 'Monthly uranium (U3O8) and thermal coal benchmark prices.',
  params: [rangeParam('5Y', ['1Y', '2Y', '5Y', '10Y'])],
  async run(ctx, params) {
    const range = toRange(params.range, '5Y');
    const months = { '1Y': 13, '2Y': 25, '5Y': 61, '10Y': 121 }[range as '1Y'] ?? 61;
    const codes = ['PURAN', 'PCOALAU', 'PCOALSA'];
    const got = await pcpsSeries(ctx, codes, monthStartBack(ctx.now(), months).slice(0, 7));
    const u = got.get('PURAN') ?? [];
    const end = last(u)?.[0];
    return {
      blocks: [
        { kind: 'chart', title: 'Uranium U3O8, USD per pound (monthly)', xType: 'time', yFormat: 'num', yDigits: 1, series: [{ name: 'Uranium', points: u }] },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Benchmark' },
            { key: 'unit', label: 'Unit' },
            { key: 'last', label: 'Month avg', format: 'num', digits: 2 },
            { key: 'prev', label: '1M', format: 'signedPct' },
            { key: 'm3', label: '3M', format: 'signedPct' },
            { key: 'y1', label: '1Y', format: 'signedPct' },
          ],
          rows: codes.filter((c) => got.has(c)).map((c) => ({ name: PCPS[c].name, unit: PCPS[c].unit, ...pointReturns(got.get(c) as Point[]) })),
        },
      ],
      sourceUrl: PCPS_URL,
      asOf: end ? ymd(end).slice(0, 7) : undefined,
      notes: ['Monthly averages from the IMF Primary Commodity Price System.'],
    };
  },
};

export const energyPriceCards: CardDef[] = [globalGas, uranium, crudeSpot, cracks, henryHub];
