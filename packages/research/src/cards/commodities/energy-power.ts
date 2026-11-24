/** Energy > Power, Outlook and International. */
import { SourceError, type Block, type CardDef, type Row } from '../../types.js';
import { EIA, eiaData, eiaNotes, eiaPoints } from './eia.js';
import { seasonalBand, seasonalChart, seasonalPosition } from './seasonal.js';
import { DAY, mean, monthStartBack, ymd, type Point } from './util.js';
import { num } from '../../http.js';

const GRID_URL = 'https://www.eia.gov/electricity/gridmonitor/dashboard/electric_overview/US48/US48';

/** Start of the hourly window: midnight UTC `days` ago, so the URL changes once a day. */
function hourlyStart(now: Date, days: number): string {
  return `${ymd(now.getTime() - days * DAY)}T00`;
}

const gridDemand: CardDef = {
  id: 'energy.grid-demand',
  title: 'U.S. grid: hourly demand and generation',
  source: EIA,
  description: 'Hourly electricity demand, day-ahead demand forecast and net generation for the Lower 48, last seven days.',
  async run(ctx) {
    const rows = await eiaData(ctx, 'electricity/rto/region-data', {
      frequency: 'hourly',
      facets: { respondent: ['US48'], type: ['D', 'DF', 'NG'] },
      start: hourlyStart(ctx.now(), 7),
      ttl: 1800,
    });
    const gw = (type: string): Point[] => eiaPoints(rows, 'type', type).map(([t, v]) => [t, v / 1000]);
    const d = gw('D');
    const df = gw('DF');
    const ng = gw('NG');
    if (!d.length) throw new SourceError(EIA, "no hourly demand returned");
    const [t, last] = d[d.length - 1];
    const day = d.filter((p) => p[0] > t - DAY).map((p) => p[1]);
    const week = d.map((p) => p[1]);
    const peak = d.reduce((a, b) => (b[1] > a[1] ? b : a));
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Demand, latest hour (GW)', value: last, format: 'num', digits: 1 },
            { label: 'Average, last 24h (GW)', value: mean(day), format: 'num', digits: 1 },
            { label: 'Average, 7 days (GW)', value: mean(week), format: 'num', digits: 1 },
            { label: '7-day peak (GW)', value: peak[1], format: 'num', digits: 1 },
            { label: 'Peak hour (UTC)', value: new Date(peak[0]).toISOString(), format: 'datetime' },
          ],
        },
        {
          kind: 'chart',
          title: 'Lower 48, gigawatts (hours in UTC)',
          xType: 'time',
          yFormat: 'num',
          yDigits: 0,
          series: [
            { name: 'Demand', points: d },
            { name: 'Day-ahead forecast', points: df.filter((p) => p[0] <= t) },
            { name: 'Net generation', points: ng },
          ],
        },
      ],
      sourceUrl: GRID_URL,
      asOf: new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      notes: ['EIA Hourly Electric Grid Monitor (form EIA-930). The most recent hours are preliminary and are revised.', ...eiaNotes(ctx)],
    };
  },
};

const fuelMix: CardDef = {
  id: 'energy.grid-fuel-mix',
  title: 'U.S. grid: generation by fuel',
  source: EIA,
  description: 'Hourly net generation by energy source for the Lower 48 over the last seven days, with each source\'s share.',
  async run(ctx) {
    const rows = await eiaData(ctx, 'electricity/rto/fuel-type-data', {
      frequency: 'hourly',
      facets: { respondent: ['US48'] },
      start: hourlyStart(ctx.now(), 7),
      ttl: 1800,
    });
    const names = new Map<string, string>();
    for (const r of rows) if (typeof r.fueltype === 'string') names.set(r.fueltype, String(r['type-name'] ?? r.fueltype));
    const fuels = [...names.keys()].map((id) => ({ id, name: names.get(id) as string, pts: eiaPoints(rows, 'fueltype', id).map(([t, v]) => [t, v / 1000] as Point) }));
    const end = Math.max(...fuels.map((f) => f.pts[f.pts.length - 1]?.[0] ?? 0));
    // Full days only for the shares: the latest hours are missing for some balancing areas.
    const avg = (pts: Point[], from: number): number => mean(pts.filter((p) => p[0] > from && p[0] <= end).map((p) => p[1])) ?? 0;
    const table = fuels
      .map((f) => ({ name: f.name, day: avg(f.pts, end - DAY), week: avg(f.pts, end - 7 * DAY), pts: f.pts }))
      .filter((r) => Math.abs(r.week) >= 0.05 || Math.abs(r.day) >= 0.05)
      .sort((a, b) => b.week - a.week);
    const totalDay = table.reduce((s, r) => s + Math.max(0, r.day), 0);
    const totalWeek = table.reduce((s, r) => s + Math.max(0, r.week), 0);
    const outRows: Row[] = table.map((r) => ({
      name: r.name,
      day: r.day,
      dayShare: totalDay ? (Math.max(0, r.day) / totalDay) * 100 : null,
      week: r.week,
      weekShare: totalWeek ? (Math.max(0, r.week) / totalWeek) * 100 : null,
    }));
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Net generation by source, gigawatts (hours in UTC)',
          xType: 'time',
          yFormat: 'num',
          yDigits: 0,
          series: table.slice(0, 6).map((r) => ({ name: r.name, points: r.pts })),
        },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Source' },
            { key: 'day', label: 'Avg GW, 24h', format: 'num', digits: 1 },
            { key: 'dayShare', label: 'Share, 24h', format: 'pct', digits: 1 },
            { key: 'week', label: 'Avg GW, 7d', format: 'num', digits: 1 },
            { key: 'weekShare', label: 'Share, 7d', format: 'pct', digits: 1 },
          ],
          rows: outRows,
        },
      ],
      sourceUrl: GRID_URL,
      asOf: new Date(end).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      notes: ['EIA Hourly Electric Grid Monitor. Shares are of positive net generation; storage shows negative values while charging. The chart shows the six largest sources.', ...eiaNotes(ctx)],
    };
  },
};

const nuclear: CardDef = {
  id: 'energy.nuclear-outages',
  title: 'U.S. nuclear outages vs five-year range',
  source: EIA,
  description: 'Daily U.S. nuclear generating capacity offline, against the five-year seasonal range.',
  async run(ctx) {
    const rows = await eiaData(ctx, 'nuclear-outages/us-nuclear-outages', {
      frequency: 'daily',
      data: ['capacity', 'outage', 'percentOutage'],
      start: `${ctx.now().getUTCFullYear() - 6}-01-01`,
    });
    const col = (field: string): Point[] => {
      const out: Point[] = [];
      for (const r of rows) {
        const t = Date.parse(`${String(r.period)}T00:00:00Z`);
        const v = num(r[field]);
        if (!Number.isNaN(t) && v !== null) out.push([t, v]);
      }
      return out.sort((a, b) => a[0] - b[0]);
    };
    const outage = col('outage').map(([t, v]) => [t, v / 1000] as Point);
    const capacity = col('capacity');
    const pct = col('percentOutage');
    if (!outage.length) throw new SourceError(EIA, "no nuclear outage data returned");
    const band = seasonalBand(outage);
    const pos = seasonalPosition(band);
    const [t, last] = outage[outage.length - 1];
    const blocks: Block[] = [
      {
        kind: 'stats',
        items: [
          { label: 'Offline (GW)', value: last, format: 'num', digits: 1 },
          { label: 'Share of capacity', value: pct[pct.length - 1]?.[1], format: 'pct', digits: 1 },
          { label: 'Total capacity (GW)', value: (capacity[capacity.length - 1]?.[1] ?? NaN) / 1000, format: 'num', digits: 1 },
          { label: '5Y average, same week (GW)', value: band.latest?.avg, format: 'num', digits: 1 },
          { label: 'vs average (GW)', value: pos.vsAvg, format: 'signed', digits: 1 },
        ],
      },
      seasonalChart(band, 'Capacity offline (GW) against the five-year range', 'num', 1),
    ];
    return {
      blocks,
      sourceUrl: 'https://www.eia.gov/nuclear/outages/',
      asOf: ymd(t),
      notes: ['Daily status reported to the Nuclear Regulatory Commission, compiled by the EIA. Each week shows its last daily reading; outages peak in the spring and autumn refuelling seasons.', ...eiaNotes(ctx)],
    };
  },
};

const STEO = [
  { id: 'WTIPUUS', key: 'wti', label: 'WTI crude', unit: 'USD/bbl', digits: 2 },
  { id: 'BREPUUS', key: 'brent', label: 'Brent crude', unit: 'USD/bbl', digits: 2 },
  { id: 'NGHHUUS', key: 'henry-hub', label: 'Henry Hub gas', unit: 'USD/MMBtu', digits: 2 },
  { id: 'MGRARUS', key: 'gasoline', label: 'Retail gasoline', unit: 'USD/gal', digits: 2 },
  { id: 'COPRPUS', key: 'us-crude', label: 'U.S. crude production', unit: 'mb/d', digits: 2 },
  { id: 'PAPR_WORLD', key: 'world-supply', label: 'World liquids production', unit: 'mb/d', digits: 1 },
  { id: 'PATC_WORLD', key: 'world-demand', label: 'World liquids consumption', unit: 'mb/d', digits: 1 },
  { id: 'NGPRPUS', key: 'us-gas', label: 'U.S. dry gas production', unit: 'Bcf/d', digits: 1 },
  { id: 'NGTCPUS', key: 'us-gas-demand', label: 'U.S. gas consumption', unit: 'Bcf/d', digits: 1 },
];

const steo: CardDef = {
  id: 'energy.steo',
  title: 'Short-Term Energy Outlook forecasts',
  source: EIA,
  description: 'EIA forecasts for oil and gas prices, production and consumption: annual averages and the monthly path.',
  params: [{ name: 'series', label: 'Series', default: 'brent', choices: STEO.map((s) => s.key) }],
  async run(ctx, params) {
    const now = ctx.now();
    const y = now.getUTCFullYear();
    const rows = await eiaData(ctx, 'steo', {
      frequency: 'monthly',
      facets: { seriesId: STEO.map((s) => s.id) },
      start: `${y - 2}-01`,
      end: `${y + 1}-12`,
    });
    const cutoff = Date.UTC(y, now.getUTCMonth(), 1);
    const yearAvg = (pts: Point[], year: number): number | null => {
      const xs = pts.filter((p) => new Date(p[0]).getUTCFullYear() === year).map((p) => p[1]);
      return xs.length === 12 ? mean(xs) : null;
    };
    const table: Row[] = [];
    let chart: Block | undefined;
    let last = 0;
    const pick = STEO.find((s) => s.key === params.series) ?? STEO[1];
    for (const s of STEO) {
      const pts = eiaPoints(rows, 'seriesId', s.id);
      if (!pts.length) continue;
      last = Math.max(last, pts[pts.length - 1][0]);
      const a = yearAvg(pts, y - 1);
      const b = yearAvg(pts, y);
      const c = yearAvg(pts, y + 1);
      table.push({ name: s.label, unit: s.unit, prev: a, cur: b, next: c, chg: b !== null && c !== null && b !== 0 ? ((c - b) / Math.abs(b)) * 100 : null });
      if (s.id === pick.id) {
        chart = {
          kind: 'chart',
          title: `${s.label}, ${s.unit} (monthly)`,
          xType: 'time',
          yFormat: 'num',
          yDigits: s.digits,
          series: [
            { name: 'History', points: pts.filter((p) => p[0] < cutoff) },
            { name: 'Forecast', points: pts.filter((p) => p[0] >= cutoff) },
          ],
        };
      }
    }
    if (!table.length) throw new SourceError(EIA, "no STEO series returned");
    return {
      blocks: [
        ...(chart ? [chart] : []),
        {
          kind: 'table',
          title: 'Annual averages',
          columns: [
            { key: 'name', label: 'Series' },
            { key: 'unit', label: 'Unit' },
            { key: 'prev', label: String(y - 1), format: 'num', digits: 2 },
            { key: 'cur', label: String(y), format: 'num', digits: 2 },
            { key: 'next', label: String(y + 1), format: 'num', digits: 2 },
            { key: 'chg', label: `${y + 1} vs ${y}`, format: 'signedPct', digits: 1 },
          ],
          rows: table,
        },
      ],
      sourceUrl: 'https://www.eia.gov/outlooks/steo/',
      asOf: ymd(cutoff).slice(0, 7),
      notes: [
        `EIA Short-Term Energy Outlook, updated monthly; the series run to ${ymd(last).slice(0, 7)}. The EIA does not flag forecast months in this feed: the current month and later are shown as forecast, and ${y} mixes actual and forecast months.`,
        ...eiaNotes(ctx),
      ],
    };
  },
};

interface CountryValue {
  id: string;
  name: string;
  pts: Point[];
}

/** International rows grouped by country, oldest first within each. */
export function byCountry(rows: Record<string, unknown>[]): CountryValue[] {
  const map = new Map<string, CountryValue>();
  for (const r of rows) {
    const id = String(r.countryRegionId ?? '');
    const v = num(r.value);
    const p = String(r.period ?? '');
    const t = /^\d{4}$/.test(p) ? Date.UTC(+p, 0, 1) : Date.parse(`${p}-01T00:00:00Z`);
    if (!id || v === null || Number.isNaN(t)) continue;
    let c = map.get(id);
    if (!c) map.set(id, (c = { id, name: String(r.countryRegionName ?? id), pts: [] }));
    c.pts.push([t, v]);
  }
  for (const c of map.values()) c.pts.sort((a, b) => a[0] - b[0]);
  return [...map.values()];
}

function intlCard(def: { id: string; title: string; description: string; activity: string; frequency: 'monthly' | 'annual'; what: string }): CardDef {
  return {
    id: def.id,
    title: def.title,
    source: EIA,
    description: def.description,
    async run(ctx) {
      const now = ctx.now();
      const rows = await eiaData(ctx, 'international', {
        frequency: def.frequency,
        facets: { productId: ['57'], activityId: [def.activity], unit: ['TBPD'], countryRegionTypeId: ['c'] },
        start: def.frequency === 'monthly' ? monthStartBack(now, 18).slice(0, 7) : String(now.getUTCFullYear() - 6),
      });
      const countries = byCountry(rows);
      // The reference period: the latest one most large producers have reported.
      const lastOf = countries.map((c) => c.pts[c.pts.length - 1][0]);
      const counts = new Map<number, number>();
      for (const t of lastOf) counts.set(t, (counts.get(t) ?? 0) + 1);
      const ref = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
      const yearBefore = Date.UTC(new Date(ref).getUTCFullYear() - 1, new Date(ref).getUTCMonth(), 1);
      const at = (c: CountryValue, t: number): number | null => c.pts.find((p) => p[0] === t)?.[1] ?? null;
      const ranked = countries
        .map((c) => ({ c, v: at(c, ref), prev: at(c, yearBefore) }))
        .filter((x): x is { c: CountryValue; v: number; prev: number | null } => x.v !== null && x.v > 0)
        .sort((a, b) => b.v - a.v);
      const total = ranked.reduce((s, x) => s + x.v, 0);
      const top = ranked.slice(0, 20);
      const label = def.frequency === 'monthly' ? ymd(ref).slice(0, 7) : String(new Date(ref).getUTCFullYear());
      return {
        blocks: [
          {
            kind: 'chart',
            title: `${def.what}, thousand barrels a day (${label})`,
            xType: 'category',
            style: 'bar',
            categories: top.slice(0, 12).map((x) => x.c.name),
            yFormat: 'int',
            series: [{ name: label, points: top.slice(0, 12).map((x, i) => [i, x.v] as [number, number]) }],
          },
          {
            kind: 'table',
            columns: [
              { key: 'name', label: 'Country', maxWidth: 28 },
              { key: 'v', label: 'kb/d', format: 'int' },
              { key: 'share', label: 'Share', format: 'pct', digits: 1 },
              { key: 'yoy', label: 'Year chg', format: 'signed', digits: 0 },
              { key: 'yoyPct', label: 'Year %', format: 'signedPct', digits: 1 },
            ],
            rows: top.map((x) => ({
              name: x.c.name,
              v: x.v,
              share: total ? (x.v / total) * 100 : null,
              yoy: x.prev === null ? null : x.v - x.prev,
              yoyPct: x.prev ? ((x.v - x.prev) / x.prev) * 100 : null,
            })),
            footnote: `Sum of reporting countries: ${Math.round(total).toLocaleString('en-US')} kb/d.`,
          },
        ],
        sourceUrl: 'https://www.eia.gov/international/data/world',
        asOf: label,
        notes: [`EIA International Energy Statistics: crude oil including lease condensate. ${def.frequency === 'monthly' ? 'Monthly data lag by about four months.' : 'Annual data lag by a year or more.'} Shares are of the countries that reported for ${label}.`, ...eiaNotes(ctx)],
      };
    },
  };
}

const intlProduction = intlCard({
  id: 'energy.intl-crude-production',
  title: 'Crude oil production by country',
  description: 'The largest crude oil producers, latest month, with share of world output and change on a year earlier.',
  activity: '1',
  frequency: 'monthly',
  what: 'Crude oil production',
});

export const energyPowerCards: CardDef[] = [gridDemand, fuelMix, nuclear];
export const energyOutlookCards: CardDef[] = [steo];
export const energyIntlCards: CardDef[] = [intlProduction];
