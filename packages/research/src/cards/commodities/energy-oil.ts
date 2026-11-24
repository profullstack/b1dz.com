/** Energy > Oil and Natural gas: weekly inventories and supply against their five-year seasonal range. */
import { SourceError, type Block, type CardDef, type CardResult, type Ctx, type Row } from '../../types.js';
import { EIA, eiaData, eiaNotes, eiaPoints, type EiaRow } from './eia.js';
import { gasStorage, STORAGE, WEEKLY, weeklyPetroleum, type StorageKey, type WeeklyKey } from './energy-data.js';
import { seasonalBand, seasonalChart, seasonalPosition } from './seasonal.js';
import { DAY, monthsBack, valueAt, ymd, type Point } from './util.js';

interface Item {
  key: string;
  id: string;
  label: string;
  unit: string;
  scale: number;
  digits: number;
}

/** A card showing one chosen weekly series against its five-year band, plus a summary row for every series in the group. */
function seasonalCard(def: {
  id: string;
  title: string;
  description: string;
  items: Item[];
  fetch(ctx: Ctx): Promise<EiaRow[]>;
  sourceUrl: string;
  note: string;
}): CardDef {
  return {
    id: def.id,
    title: def.title,
    source: EIA,
    description: def.description,
    params: [{ name: 'series', label: 'Series', default: def.items[0].key, choices: def.items.map((i) => i.key) }],
    async run(ctx, params): Promise<CardResult> {
      const rows = await def.fetch(ctx);
      const pick = def.items.find((i) => i.key === params.series) ?? def.items[0];
      const points = (it: Item): Point[] => eiaPoints(rows, 'series', it.id).map(([t, v]) => [t, v * it.scale]);
      const summary: Row[] = [];
      let asOf = 0;
      let chart: Block | undefined;
      for (const it of def.items) {
        const pts = points(it);
        if (!pts.length) continue;
        const [t, last] = pts[pts.length - 1];
        asOf = Math.max(asOf, t);
        const band = seasonalBand(pts);
        const pos = seasonalPosition(band);
        const prev = pts.length > 1 ? pts[pts.length - 2][1] : null;
        const yearAgo = valueAt(pts, monthsBack(t, 12) + 3 * DAY);
        summary.push({
          name: it.label,
          unit: it.unit,
          last,
          wow: prev === null ? null : last - prev,
          yoy: yearAgo === null ? null : last - yearAgo,
          avg: band.latest?.avg,
          vsAvg: pos.vsAvg,
          vsAvgPct: pos.vsAvgPct,
          date: ymd(t),
        });
        if (it.key === pick.key) chart = seasonalChart(band, `${it.label} (${it.unit}) against the five-year range`, 'num', it.digits);
      }
      if (!summary.length || !chart) throw new SourceError(EIA, "no weekly data returned");
      const digits = Math.max(...def.items.map((i) => i.digits));
      return {
        blocks: [
          chart,
          {
            kind: 'table',
            columns: [
              { key: 'name', label: 'Series' },
              { key: 'unit', label: 'Unit' },
              { key: 'last', label: 'Latest', format: 'num', digits },
              { key: 'wow', label: 'Week chg', format: 'signed', digits },
              { key: 'yoy', label: 'Year chg', format: 'signed', digits },
              { key: 'avg', label: '5Y avg', format: 'num', digits },
              { key: 'vsAvg', label: 'vs avg', format: 'signed', digits },
              { key: 'vsAvgPct', label: 'vs avg %', format: 'signedPct', digits: 1 },
              { key: 'date', label: 'Week ending', format: 'date' },
            ],
            rows: summary,
          },
        ],
        sourceUrl: def.sourceUrl,
        asOf: ymd(asOf),
        notes: [def.note, ...eiaNotes(ctx)],
      };
    },
  };
}

const items = (keys: WeeklyKey[]): Item[] => keys.map((k) => ({ key: k, ...WEEKLY[k] }));

const BAND_NOTE =
  'The range is the low, high and average for the same week of the year over the previous five calendar years, computed here from the weekly history.';

const oilStocks = seasonalCard({
  id: 'energy.oil-stocks',
  title: 'U.S. petroleum inventories vs five-year range',
  description: 'Weekly commercial crude, SPR, Cushing, gasoline and distillate stocks against their five-year seasonal range.',
  items: items(['crude', 'cushing', 'gasoline', 'distillate', 'spr']),
  fetch: weeklyPetroleum,
  sourceUrl: 'https://www.eia.gov/petroleum/supply/weekly/',
  note: `Weekly Petroleum Status Report, million barrels. ${BAND_NOTE}`,
});

const oilSupply = seasonalCard({
  id: 'energy.oil-supply',
  title: 'U.S. refinery runs, crude production, trade and demand',
  description: 'Weekly refinery utilization, crude production, imports, exports and total products supplied against their five-year range.',
  items: items(['utilization', 'production', 'imports', 'exports', 'supplied']),
  fetch: weeklyPetroleum,
  sourceUrl: 'https://www.eia.gov/petroleum/supply/weekly/',
  note: `Weekly Petroleum Status Report estimates; flows in thousand barrels a day. Products supplied is the EIA's proxy for demand. ${BAND_NOTE}`,
});

const storage = seasonalCard({
  id: 'energy.gas-storage',
  title: 'U.S. working gas in storage vs five-year range',
  description: 'Weekly working natural gas in underground storage, Lower 48 and by region, against the five-year seasonal range.',
  items: (Object.keys(STORAGE) as StorageKey[]).map((k) => ({ key: k, id: STORAGE[k].id, label: STORAGE[k].label, unit: 'Bcf', scale: 1, digits: 0 })),
  fetch: gasStorage,
  sourceUrl: 'https://ir.eia.gov/ngs/ngs.html',
  note: `Weekly Natural Gas Storage Report, billion cubic feet. ${BAND_NOTE}`,
});

/** Monthly volume in million cubic feet to an average daily rate in billion cubic feet. */
export function mmcfToBcfd(t: number, mmcf: number): number {
  const d = new Date(t);
  const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return mmcf / days / 1000;
}

const GAS_MONTHLY = [
  { id: 'N9070US2', label: 'Dry gas production' },
  { id: 'N9140US2', label: 'Total consumption' },
  { id: 'N9133US2', label: 'LNG exports' },
  { id: 'N9130US2', label: 'Total exports' },
  { id: 'N9100US2', label: 'Total imports' },
];

const gasSupply: CardDef = {
  id: 'energy.gas-supply',
  title: 'U.S. natural gas production and LNG exports',
  source: EIA,
  description: 'Monthly dry gas production, consumption, LNG exports and total trade, as average daily rates.',
  async run(ctx) {
    const rows = await eiaData(ctx, 'natural-gas/sum/lsum', {
      frequency: 'monthly',
      facets: { series: GAS_MONTHLY.map((s) => s.id) },
      start: `${ctx.now().getUTCFullYear() - 6}-01`,
    });
    const series = GAS_MONTHLY.map((s) => ({ ...s, pts: eiaPoints(rows, 'series', s.id).map(([t, v]) => [t, mmcfToBcfd(t, v)] as Point) })).filter((s) => s.pts.length);
    if (!series.length) throw new SourceError(EIA, "no monthly natural gas series returned");
    let asOf = 0;
    const table: Row[] = series.map((s) => {
      const [t, last] = s.pts[s.pts.length - 1];
      asOf = Math.max(asOf, t);
      const prev = s.pts.length > 1 ? s.pts[s.pts.length - 2][1] : null;
      const yearAgo = valueAt(s.pts, monthsBack(t, 12));
      return { name: s.label, last, mom: prev === null ? null : last - prev, yoy: yearAgo === null ? null : last - yearAgo, yoyPct: yearAgo ? ((last - yearAgo) / yearAgo) * 100 : null, month: ymd(t).slice(0, 7) };
    });
    const chartOf = (ids: string[], title: string): Block => ({
      kind: 'chart',
      title,
      xType: 'time',
      yFormat: 'num',
      yDigits: 1,
      series: series.filter((s) => ids.includes(s.id)).map((s) => ({ name: s.label, points: s.pts })),
    });
    return {
      blocks: [
        chartOf(['N9133US2', 'N9130US2'], 'Exports, Bcf per day'),
        chartOf(['N9070US2', 'N9140US2'], 'Production and consumption, Bcf per day'),
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Series (Bcf/d)' },
            { key: 'last', label: 'Latest', format: 'num', digits: 1 },
            { key: 'mom', label: 'Month chg', format: 'signed', digits: 1 },
            { key: 'yoy', label: 'Year chg', format: 'signed', digits: 1 },
            { key: 'yoyPct', label: 'Year %', format: 'signedPct', digits: 1 },
            { key: 'month', label: 'Month' },
          ],
          rows: table,
        },
      ],
      sourceUrl: 'https://www.eia.gov/dnav/ng/ng_sum_lsum_dcu_nus_m.htm',
      asOf: ymd(asOf).slice(0, 7),
      notes: ['Natural Gas Monthly; published about two months after the reference month. Monthly volumes are converted here to average billion cubic feet a day.', ...eiaNotes(ctx)],
    };
  },
};

export const energyOilCards: CardDef[] = [oilStocks, oilSupply];
export const energyGasCards: CardDef[] = [storage, gasSupply];
