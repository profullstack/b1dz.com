/** U.S. Economy: prices (CPI, PPI) and labor (payrolls, unemployment, JOLTS) from the BLS. */
import { SourceError, type Block, type CardDef, type Row } from '../../types.js';
import { BLS_KEYLESS_NOTE, blsSeries, changeOver, diffOver, monthsBefore, yoySeries, type BlsObs } from './bls.js';

interface Item {
  id: string;
  label: string;
}

const CPI_ITEMS: Item[] = [
  { id: 'CUUR0000SA0', label: 'All items' },
  { id: 'CUUR0000SA0L1E', label: 'All items less food and energy (core)' },
  { id: 'CUUR0000SAF1', label: 'Food' },
  { id: 'CUUR0000SAF11', label: '  Food at home' },
  { id: 'CUUR0000SEFV', label: '  Food away from home' },
  { id: 'CUUR0000SA0E', label: 'Energy' },
  { id: 'CUUR0000SETB01', label: '  Gasoline' },
  { id: 'CUUR0000SEHF01', label: '  Electricity' },
  { id: 'CUUR0000SACL1E', label: 'Goods less food and energy' },
  { id: 'CUUR0000SETA01', label: '  New vehicles' },
  { id: 'CUUR0000SETA02', label: '  Used cars and trucks' },
  { id: 'CUUR0000SAA', label: '  Apparel' },
  { id: 'CUUR0000SASLE', label: 'Services less energy' },
  { id: 'CUUR0000SAH1', label: '  Shelter' },
  { id: 'CUUR0000SEHA', label: '    Rent of primary residence' },
  { id: 'CUUR0000SEHC', label: "    Owners' equivalent rent" },
  { id: 'CUUR0000SAM2', label: '  Medical care services' },
  { id: 'CUUR0000SETE', label: '  Motor vehicle insurance' },
  { id: 'CUUR0000SETG01', label: '  Airline fares' },
];
const CPI_SA = ['CUSR0000SA0', 'CUSR0000SA0L1E'];

const PPI_ITEMS: Item[] = [
  { id: 'WPUFD4', label: 'Final demand' },
  { id: 'WPUFD49104', label: 'Final demand less foods and energy' },
  { id: 'WPUFD49116', label: 'Final demand less foods, energy and trade services' },
  { id: 'WPUFD41', label: 'Final demand goods' },
  { id: 'WPUFD411', label: '  Foods' },
  { id: 'WPUFD412', label: '  Energy' },
  { id: 'WPUFD413', label: '  Goods less foods and energy' },
  { id: 'WPUFD42', label: 'Final demand services' },
  { id: 'WPUFD422', label: '  Trade services' },
  { id: 'WPUFD421', label: '  Transportation and warehousing' },
  { id: 'WPUFD43', label: 'Final demand construction' },
  { id: 'WPUID61', label: 'Intermediate demand: processed goods' },
  { id: 'WPUID62', label: 'Intermediate demand: unprocessed goods' },
  { id: 'WPU00000000', label: 'All commodities' },
];
const PPI_SA = ['WPSFD4', 'WPSFD49104'];

function latestCommonPeriod(lists: BlsObs[][]): string | undefined {
  return lists
    .map((l) => l[l.length - 1]?.period)
    .filter((p): p is string => Boolean(p))
    .sort()
    .pop();
}

/** The newest 12-month change that can be computed (the latest month can lack a year-ago base after a publication gap). */
function lastYoy(list: BlsObs[]): { value: number | null; period: string } {
  for (let i = list.length - 1; i >= 0 && i >= list.length - 6; i--) {
    const v = changeOver(list, 12, i);
    if (v !== null) return { value: v, period: list[i].period };
  }
  return { value: null, period: list[list.length - 1]?.period ?? '' };
}

/** One table row per index: level, 12-month change now, a month ago and a year ago. */
function priceRows(items: Item[], series: Map<string, BlsObs[]>): Row[] {
  const rows: Row[] = [];
  for (const it of items) {
    const list = series.get(it.id) ?? [];
    if (!list.length) continue;
    const i = list.length - 1;
    const yearAgoIndex = list.findIndex((o) => o === monthsBefore(list, i, 12));
    rows.push({
      item: it.label,
      month: list[i].period,
      index: list[i].value,
      yoy: changeOver(list, 12, i),
      yoyPrev: i > 0 ? changeOver(list, 12, i - 1) : null,
      yoyYearAgo: yearAgoIndex >= 0 ? changeOver(list, 12, yearAgoIndex) : null,
      mom: changeOver(list, 1, i),
    });
  }
  return rows;
}

function priceCard(opts: { id: string; title: string; description: string; items: Item[]; sa: string[]; chartTitle: string; url: string; headline: string; core: string }): CardDef {
  return {
    id: opts.id,
    title: opts.title,
    source: 'BLS',
    description: opts.description,
    async run(ctx) {
      const year = ctx.now().getUTCFullYear();
      const { series, keyed } = await blsSeries(ctx, [...opts.items.map((i) => i.id), ...opts.sa], year - 3, year);
      const rows = priceRows(opts.items, series);
      if (!rows.length) throw new SourceError('BLS', 'no observations returned');
      const head = series.get(opts.items[0].id) ?? [];
      const core = series.get(opts.items[1].id) ?? [];
      const headSa = series.get(opts.sa[0]) ?? [];
      const coreSa = series.get(opts.sa[1]) ?? [];
      const headYoy = lastYoy(head);
      const coreYoy = lastYoy(core);
      const blocks: Block[] = [
        {
          kind: 'stats',
          items: [
            { label: `${opts.headline}, 12-month (${headYoy.period})`, value: headYoy.value, format: 'pct', digits: 1 },
            { label: `${opts.core}, 12-month (${coreYoy.period})`, value: coreYoy.value, format: 'pct', digits: 1 },
            { label: `${opts.headline}, 1-month (SA)`, value: changeOver(headSa, 1), format: 'signedPct', digits: 1 },
            { label: `${opts.core}, 1-month (SA)`, value: changeOver(coreSa, 1), format: 'signedPct', digits: 1 },
            { label: 'Reference month', value: head[head.length - 1]?.period ?? null },
          ],
        },
        {
          kind: 'chart',
          title: opts.chartTitle,
          xType: 'time',
          series: [
            { name: opts.headline, points: yoySeries(head) },
            { name: opts.core, points: yoySeries(core) },
          ],
          yFormat: 'pct',
          yDigits: 1,
        },
        {
          kind: 'table',
          columns: [
            { key: 'item', label: 'Item' },
            { key: 'yoy', label: '12M %', format: 'signedPct', digits: 1 },
            { key: 'yoyPrev', label: 'Prior month', format: 'signedPct', digits: 1 },
            { key: 'yoyYearAgo', label: 'Year ago', format: 'signedPct', digits: 1 },
            { key: 'mom', label: '1M % (NSA)', format: 'signedPct', digits: 1 },
            { key: 'index', label: 'Index', format: 'num', digits: 1 },
            { key: 'month', label: 'Month' },
          ],
          rows,
        },
      ];
      const notes = ['12-month changes use the not seasonally adjusted indexes, as the BLS headline does; the 1-month figures in the summary are seasonally adjusted.', 'A blank change means a month in the comparison was not published.'];
      if (!keyed) notes.push(BLS_KEYLESS_NOTE);
      return { blocks, sourceUrl: opts.url, asOf: latestCommonPeriod([head, core]), notes };
    },
  };
}

const cpi = priceCard({
  id: 'macro.us-cpi',
  title: 'Consumer Price Index',
  description: 'U.S. CPI: headline, core and major components with 12-month changes.',
  items: CPI_ITEMS,
  sa: CPI_SA,
  chartTitle: 'CPI, 12-month % change',
  url: 'https://www.bls.gov/cpi/',
  headline: 'CPI',
  core: 'Core CPI',
});

const ppi = priceCard({
  id: 'macro.us-ppi',
  title: 'Producer Price Index',
  description: 'U.S. PPI: final demand, core measures and components with 12-month changes.',
  items: PPI_ITEMS,
  sa: PPI_SA,
  chartTitle: 'PPI final demand, 12-month % change',
  url: 'https://www.bls.gov/ppi/',
  headline: 'PPI',
  core: 'Core PPI',
});

interface LaborItem extends Item {
  /** How the change columns are computed: level difference, or percent change. */
  change: 'diff' | 'pct';
  format: 'int' | 'pct' | 'usd' | 'num';
  digits: number;
  unit: string;
}

const LABOR: LaborItem[] = [
  { id: 'CES0000000001', label: 'Nonfarm payrolls', change: 'diff', format: 'int', digits: 0, unit: 'thousands' },
  { id: 'CES0500000001', label: 'Private payrolls', change: 'diff', format: 'int', digits: 0, unit: 'thousands' },
  { id: 'LNS14000000', label: 'Unemployment rate', change: 'diff', format: 'pct', digits: 1, unit: '%' },
  { id: 'LNS13327709', label: 'Underemployment rate (U-6)', change: 'diff', format: 'pct', digits: 1, unit: '%' },
  { id: 'LNS11300000', label: 'Labor force participation', change: 'diff', format: 'pct', digits: 1, unit: '%' },
  { id: 'LNS12300000', label: 'Employment-population ratio', change: 'diff', format: 'pct', digits: 1, unit: '%' },
  { id: 'CES0500000003', label: 'Average hourly earnings', change: 'pct', format: 'usd', digits: 2, unit: '$' },
  { id: 'CES0500000002', label: 'Average weekly hours', change: 'diff', format: 'num', digits: 1, unit: 'hours' },
  { id: 'JTS000000000000000JOL', label: 'Job openings (JOLTS)', change: 'diff', format: 'int', digits: 0, unit: 'thousands' },
  { id: 'JTS000000000000000HIL', label: 'Hires (JOLTS)', change: 'diff', format: 'int', digits: 0, unit: 'thousands' },
  { id: 'JTS000000000000000QUL', label: 'Quits (JOLTS)', change: 'diff', format: 'int', digits: 0, unit: 'thousands' },
  { id: 'JTS000000000000000QUR', label: 'Quits rate (JOLTS)', change: 'diff', format: 'pct', digits: 1, unit: '%' },
  { id: 'JTS000000000000000LDL', label: 'Layoffs and discharges (JOLTS)', change: 'diff', format: 'int', digits: 0, unit: 'thousands' },
];

const labor: CardDef = {
  id: 'macro.us-labor',
  title: 'Labor Market',
  source: 'BLS',
  description: 'Payrolls, unemployment, participation, hourly earnings and JOLTS openings, hires and quits.',
  async run(ctx) {
    const year = ctx.now().getUTCFullYear();
    const { series, keyed } = await blsSeries(ctx, LABOR.map((l) => l.id), year - 3, year);
    const rows: Row[] = [];
    for (const it of LABOR) {
      const list = series.get(it.id) ?? [];
      if (!list.length) continue;
      const i = list.length - 1;
      const change = it.change === 'pct' ? changeOver(list, 1, i) : diffOver(list, 1, i);
      const year12 = it.change === 'pct' ? changeOver(list, 12, i) : diffOver(list, 12, i);
      rows.push({
        item: it.label,
        latest: list[i].value,
        unit: it.unit,
        month: list[i].period,
        change,
        year12,
        changeUnit: it.change === 'pct' ? '%' : it.unit === '%' ? 'pp' : it.unit,
      });
    }
    if (!rows.length) throw new SourceError('BLS', 'no observations returned');
    const payrolls = series.get('CES0000000001') ?? [];
    const unemp = series.get('LNS14000000') ?? [];
    const earnings = series.get('CES0500000003') ?? [];
    const openings = series.get('JTS000000000000000JOL') ?? [];
    const gains: { label: string; value: number }[] = [];
    for (let i = Math.max(1, payrolls.length - 18); i < payrolls.length; i++) {
      const d = diffOver(payrolls, 1, i);
      if (d !== null) gains.push({ label: payrolls[i].period, value: d });
    }
    const blocks: Block[] = [
      {
        kind: 'stats',
        items: [
          { label: 'Payrolls, 1-month change (thousands)', value: diffOver(payrolls, 1), format: 'signed', digits: 0 },
          { label: 'Unemployment rate', value: unemp[unemp.length - 1]?.value ?? null, format: 'pct', digits: 1 },
          { label: `Hourly earnings, 12-month (${lastYoy(earnings).period})`, value: lastYoy(earnings).value, format: 'pct', digits: 1 },
          { label: 'Job openings (thousands)', value: openings[openings.length - 1]?.value ?? null, format: 'int' },
          { label: 'Payroll month', value: payrolls[payrolls.length - 1]?.period ?? null },
          { label: 'JOLTS month', value: openings[openings.length - 1]?.period ?? null },
        ],
      },
    ];
    if (gains.length) {
      blocks.push({
        kind: 'chart',
        title: 'Nonfarm payrolls, monthly change (thousands)',
        xType: 'category',
        style: 'bar',
        categories: gains.map((g) => g.label),
        series: [{ name: 'Payroll change', points: gains.map((g, i) => [i, g.value]) }],
        yFormat: 'signed',
        yDigits: 0,
      });
    }
    blocks.push({ kind: 'chart', title: 'Unemployment rate', xType: 'time', series: [{ name: 'Unemployment rate', points: unemp.map((o) => [o.t, o.value]) }], yFormat: 'pct', yDigits: 1 });
    blocks.push({
      kind: 'table',
      columns: [
        { key: 'item', label: 'Indicator' },
        { key: 'latest', label: 'Latest', format: 'num', digits: 1 },
        { key: 'unit', label: 'Unit' },
        { key: 'month', label: 'Month' },
        { key: 'change', label: '1M change', format: 'signed', digits: 1 },
        { key: 'year12', label: '12M change', format: 'signed', digits: 1 },
        { key: 'changeUnit', label: 'Change unit' },
      ],
      rows,
    });
    const notes = ['Seasonally adjusted. Payroll and JOLTS levels are in thousands; rate changes are in percentage points; earnings changes are percent.', 'JOLTS is published about a month after the payroll report, so its latest month is earlier.', 'A blank change means a month in the comparison was not published.'];
    if (!keyed) notes.push(BLS_KEYLESS_NOTE);
    return { blocks, sourceUrl: 'https://www.bls.gov/bls/newsrels.htm', asOf: payrolls[payrolls.length - 1]?.period, notes };
  },
};

export const usBlsCards: CardDef[] = [cpi, ppi, labor];
