/** Trade & Shipping: chokepoint transits, port activity and bilateral trade. */
import { pctChange } from '../../format.js';
import { SourceError, type CardDef, type DashboardDef, type Row } from '../../types.js';
import { resolveEconomy } from './countries.js';
import { RANGE_CHOICES, rangeStartMs } from './data.js';
import {
  arcDate,
  arcQuery,
  CHOKEPOINTS,
  chokepointDaily,
  chokepointYearAverage,
  findChokepoint,
  PORTWATCH_URL,
  smoothed,
  summariseTransits,
  windowMean,
  ymd,
  type Attrs,
  type DailyTransits,
} from './portwatch.js';

const DAY = 86_400_000;
const AIS_NOTE = 'Transit counts are IMF PortWatch estimates from satellite ship-tracking (AIS) and are revised; the latest days can be incomplete.';

function byPort(rows: DailyTransits[]): Map<string, DailyTransits[]> {
  const m = new Map<string, DailyTransits[]>();
  for (const r of rows) {
    const list = m.get(r.portid);
    if (list) list.push(r);
    else m.set(r.portid, [r]);
  }
  return m;
}

const chokepoints: CardDef = {
  id: 'macro.chokepoints',
  title: 'Maritime Chokepoints',
  source: 'IMF PortWatch',
  description: 'Daily vessel transits through eight chokepoints: the 7-day average by ship type against a year earlier and the 2023 average.',
  async run(ctx) {
    const now = ctx.now().getTime();
    const [daily, base] = await Promise.all([chokepointDaily(ctx, CHOKEPOINTS.map((c) => c.id), now - 385 * DAY), chokepointYearAverage(ctx, 2023)]);
    const end = daily[daily.length - 1].t;
    const grouped = byPort(daily);
    const rows: Row[] = CHOKEPOINTS.map((c) => {
      const list = grouped.get(c.id) ?? [];
      const b = base.get(c.id);
      const total = summariseTransits(list, 'n_total', end, b?.n_total ?? null);
      return {
        chokepoint: c.name,
        total: total.latest,
        tanker: windowMean(list, 'n_tanker', end),
        container: windowMean(list, 'n_container', end),
        bulk: windowMean(list, 'n_dry_bulk', end),
        yearAgo: total.yearAgo,
        vsYear: total.vsYearAgo,
        base: b?.n_total ?? null,
        vsBase: total.vsBaseline,
        tankerVsBase: pctChange(windowMean(list, 'n_tanker', end), b?.n_tanker ?? null),
      };
    });
    if (rows.every((r) => r.total === null)) throw new SourceError('IMF PortWatch', 'no recent transits for the monitored chokepoints');
    return {
      blocks: [
        {
          kind: 'table',
          title: `Vessels per day, 7-day average to ${ymd(end)}`,
          columns: [
            { key: 'chokepoint', label: 'Chokepoint' },
            { key: 'total', label: 'All vessels', format: 'num', digits: 1 },
            { key: 'tanker', label: 'Tankers', format: 'num', digits: 1 },
            { key: 'container', label: 'Container', format: 'num', digits: 1 },
            { key: 'bulk', label: 'Dry bulk', format: 'num', digits: 1 },
            { key: 'yearAgo', label: 'Year ago', format: 'num', digits: 1 },
            { key: 'vsYear', label: 'vs year ago', format: 'signedPct', digits: 1 },
            { key: 'base', label: '2023 avg', format: 'num', digits: 1 },
            { key: 'vsBase', label: 'vs 2023', format: 'signedPct', digits: 1 },
            { key: 'tankerVsBase', label: 'Tankers vs 2023', format: 'signedPct', digits: 1 },
          ],
          rows,
          footnote: 'All vessels also counts general cargo and roll-on/roll-off ships. Year ago is the same seven weekdays 52 weeks earlier.',
        },
      ],
      sourceUrl: PORTWATCH_URL,
      asOf: ymd(end),
      notes: [AIS_NOTE, '2023 is the comparison year because it precedes the Red Sea attacks and the Panama Canal drought restrictions.'],
    };
  },
};

const chokepointHistory: CardDef = {
  id: 'macro.chokepoint-history',
  title: 'Chokepoint Transit History',
  source: 'IMF PortWatch',
  description: 'Daily transits through one chokepoint by ship type, as a 7-day average.',
  params: [
    { name: 'chokepoint', label: 'Chokepoint', default: 'Strait of Hormuz', choices: CHOKEPOINTS.map((c) => c.name) },
    { name: 'range', label: 'Range', default: '2Y', choices: RANGE_CHOICES },
  ],
  async run(ctx, p) {
    const cp = findChokepoint(p.chokepoint);
    const from = Math.max(rangeStartMs(p.range, ctx.now(), '2Y'), Date.UTC(2019, 0, 1)) - 6 * DAY;
    const daily = await chokepointDaily(ctx, [cp.id], from);
    const end = daily[daily.length - 1].t;
    const s = summariseTransits(daily, 'n_total', end, null);
    const peak = daily.reduce((m, r) => (r.n_total > m.n_total ? r : m), daily[0]);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Vessels per day (7-day avg)', value: s.latest, format: 'num', digits: 1 },
            { label: 'Tankers', value: windowMean(daily, 'n_tanker', end), format: 'num', digits: 1 },
            { label: 'Container ships', value: windowMean(daily, 'n_container', end), format: 'num', digits: 1 },
            { label: 'Dry bulk', value: windowMean(daily, 'n_dry_bulk', end), format: 'num', digits: 1 },
            { label: 'vs year ago', value: s.vsYearAgo, format: 'signedPct', digits: 1 },
            { label: `Busiest day in range (${ymd(peak.t)})`, value: peak.n_total, format: 'int' },
          ],
        },
        {
          kind: 'chart',
          title: `${cp.name}: vessels per day, 7-day average`,
          xType: 'time',
          series: [
            { name: 'All vessels', points: smoothed(daily, 'n_total') },
            { name: 'Tankers', points: smoothed(daily, 'n_tanker') },
            { name: 'Container', points: smoothed(daily, 'n_container') },
            { name: 'Dry bulk', points: smoothed(daily, 'n_dry_bulk') },
          ],
          yFormat: 'num',
          yDigits: 0,
        },
      ],
      sourceUrl: PORTWATCH_URL,
      asOf: ymd(end),
      notes: [AIS_NOTE],
    };
  },
};

const DIVERSION = ['chokepoint4', 'chokepoint1', 'chokepoint7'];

const diversion: CardDef = {
  id: 'macro.red-sea-diversion',
  title: 'Red Sea vs Cape of Good Hope',
  source: 'IMF PortWatch',
  description: 'Vessel transits through Bab el-Mandeb and the Suez Canal against those rounding the Cape of Good Hope, since 2023.',
  async run(ctx) {
    const [daily, base] = await Promise.all([chokepointDaily(ctx, DIVERSION, Date.UTC(2023, 0, 1)), chokepointYearAverage(ctx, 2023)]);
    const end = daily[daily.length - 1].t;
    const grouped = byPort(daily);
    const names = new Map(CHOKEPOINTS.map((c) => [c.id, c.name]));
    const rows: Row[] = DIVERSION.map((id) => {
      const list = grouped.get(id) ?? [];
      const b = base.get(id);
      const total = summariseTransits(list, 'n_total', end, b?.n_total ?? null);
      const container = summariseTransits(list, 'n_container', end, b?.n_container ?? null);
      return { route: names.get(id) ?? id, total: total.latest, base: b?.n_total ?? null, vsBase: total.vsBaseline, container: container.latest, containerBase: b?.n_container ?? null, containerVsBase: container.vsBaseline };
    });
    return {
      blocks: [
        { kind: 'chart', title: 'All vessels per day, 7-day average', xType: 'time', series: DIVERSION.map((id) => ({ name: names.get(id) ?? id, points: smoothed(grouped.get(id) ?? [], 'n_total') })), yFormat: 'num', yDigits: 0 },
        {
          kind: 'table',
          columns: [
            { key: 'route', label: 'Route' },
            { key: 'total', label: 'All vessels/day', format: 'num', digits: 1 },
            { key: 'base', label: '2023 avg', format: 'num', digits: 1 },
            { key: 'vsBase', label: 'vs 2023', format: 'signedPct', digits: 1 },
            { key: 'container', label: 'Container/day', format: 'num', digits: 1 },
            { key: 'containerBase', label: '2023 avg', format: 'num', digits: 1 },
            { key: 'containerVsBase', label: 'vs 2023', format: 'signedPct', digits: 1 },
          ],
          rows,
          footnote: `7-day average to ${ymd(end)}.`,
        },
      ],
      sourceUrl: PORTWATCH_URL,
      asOf: ymd(end),
      notes: ['Ships avoiding the Red Sea sail around southern Africa instead, so falling Bab el-Mandeb and Suez counts show up as rising Cape of Good Hope counts.', AIS_NOTE],
    };
  },
};

function sumStats(where: string): Record<string, string> {
  return {
    where,
    groupByFieldsForStatistics: 'portid',
    outStatistics: JSON.stringify(['portcalls', 'import', 'export'].map((f) => ({ statisticType: 'sum', onStatisticField: f, outStatisticFieldName: `sum_${f}` }))),
  };
}

function n(v: string | number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const ports: CardDef = {
  id: 'macro.ports',
  title: 'Major Ports',
  source: 'IMF PortWatch',
  description: 'Port calls and estimated import and export volume over the latest week at the 25 busiest ports, against a year earlier.',
  async run(ctx) {
    const top = await arcQuery(ctx, 'PortWatch_ports_database', { outFields: 'portid,portname,country,vessel_count_total', orderByFields: 'vessel_count_total DESC', resultRecordCount: '25' }, 86400);
    if (!top.length) throw new SourceError('IMF PortWatch', 'no ports returned');
    const ids = top.map((t) => String(t.portid).replace(/[^a-z0-9]/gi, ''));
    const inList = ids.map((i) => `'${i}'`).join(',');
    const newest = await arcQuery(ctx, 'Daily_Ports_Data', { where: `portid = '${ids[0]}'`, outFields: 'date', orderByFields: 'date DESC', resultRecordCount: '1' });
    const end = arcDate(newest[0]?.date);
    if (end === null) throw new SourceError('IMF PortWatch', 'no daily port data');
    const week = (e: number): string => `portid IN (${inList}) AND date >= DATE '${ymd(e - 6 * DAY)}' AND date <= DATE '${ymd(e)}'`;
    const [cur, prev] = await Promise.all([arcQuery(ctx, 'Daily_Ports_Data', sumStats(week(end))), arcQuery(ctx, 'Daily_Ports_Data', sumStats(week(end - 364 * DAY)), 86400)]);
    const index = (rows: Attrs[]): Map<string, Attrs> => new Map(rows.map((r) => [String(r.portid), r]));
    const c = index(cur);
    const y = index(prev);
    const rows: Row[] = top.map((t) => {
      const a = c.get(String(t.portid));
      const b = y.get(String(t.portid));
      const vol = a ? (n(a.sum_import) ?? 0) + (n(a.sum_export) ?? 0) : null;
      const volPrev = b ? (n(b.sum_import) ?? 0) + (n(b.sum_export) ?? 0) : null;
      return {
        port: t.portname,
        country: t.country,
        calls: n(a?.sum_portcalls),
        callsYoy: pctChange(n(a?.sum_portcalls), n(b?.sum_portcalls)),
        imports: n(a?.sum_import),
        exports: n(a?.sum_export),
        volYoy: pctChange(vol, volPrev),
        annual: n(t.vessel_count_total),
      };
    });
    if (rows.every((r) => r.calls === null)) throw new SourceError('IMF PortWatch', 'no port activity in the latest week');
    return {
      blocks: [
        {
          kind: 'table',
          title: `Week to ${ymd(end)}`,
          columns: [
            { key: 'port', label: 'Port' },
            { key: 'country', label: 'Country', maxWidth: 22 },
            { key: 'calls', label: 'Port calls', format: 'int' },
            { key: 'callsYoy', label: 'vs year ago', format: 'signedPct', digits: 1 },
            { key: 'imports', label: 'Imports (t)', format: 'compact', digits: 2 },
            { key: 'exports', label: 'Exports (t)', format: 'compact', digits: 2 },
            { key: 'volYoy', label: 'Volume vs year ago', format: 'signedPct', digits: 1 },
            { key: 'annual', label: 'Annual vessel count', format: 'int' },
          ],
          rows,
          footnote: 'The 25 ports with the most vessel calls a year. Volumes are metric tons of cargo estimated from ship size and draught.',
        },
      ],
      sourceUrl: PORTWATCH_URL,
      asOf: ymd(end),
      notes: ['Port calls and trade volumes are IMF PortWatch estimates from ship-tracking data, not customs statistics.', 'Year ago is the same seven weekdays 52 weeks earlier.'],
    };
  },
};

const EVENT_TYPES: Record<string, string> = { EQ: 'Earthquake', TC: 'Tropical cyclone', FL: 'Flood', DR: 'Drought', VO: 'Volcano', WF: 'Wildfire', TS: 'Tsunami', OT: 'Other' };

const disruptions: CardDef = {
  id: 'macro.port-disruptions',
  title: 'Port Disruptions',
  source: 'IMF PortWatch',
  description: 'The latest natural-hazard and other events flagged as affecting ports.',
  async run(ctx) {
    const rows = await arcQuery(ctx, 'portwatch_disruptions_database', {
      outFields: 'eventid,eventtype,eventname,alertlevel,country,fromdate,todate,severitytext,n_affectedports,affectedpopulation',
      orderByFields: 'fromdate DESC',
      resultRecordCount: '30',
    });
    if (!rows.length) throw new SourceError('IMF PortWatch', 'no disruption events returned');
    const table: Row[] = rows.map((r) => ({
      from: arcDate(r.fromdate),
      to: arcDate(r.todate),
      event: r.eventname,
      type: EVENT_TYPES[String(r.eventtype)] ?? r.eventtype,
      alert: r.alertlevel,
      country: r.country,
      ports: n(r.n_affectedports),
      severity: r.severitytext,
    }));
    const newest = table[0].from as number | null;
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'from', label: 'From', format: 'date' },
            { key: 'to', label: 'To', format: 'date' },
            { key: 'event', label: 'Event', maxWidth: 44 },
            { key: 'type', label: 'Type' },
            { key: 'alert', label: 'Alert' },
            { key: 'country', label: 'Country', maxWidth: 28 },
            { key: 'ports', label: 'Ports affected', format: 'int' },
            { key: 'severity', label: 'Severity', maxWidth: 44 },
          ],
          rows: table,
        },
      ],
      sourceUrl: 'https://portwatch.imf.org/pages/disruption-monitor',
      asOf: newest === null ? undefined : ymd(newest),
      notes: ['Events come from the Global Disaster Alert and Coordination System and are matched to nearby ports by PortWatch. Alert levels are GDACS red, orange or green.'],
    };
  },
};

interface ComtradeRow {
  partnerCode?: number;
  flowCode?: string;
  primaryValue?: number | null;
  period?: string;
}

interface ComtradeRef {
  results?: { id?: number; text?: string; reporterCodeIsoAlpha2?: string; PartnerCodeIsoAlpha2?: string; isGroup?: boolean; entryExpiredDate?: string | null }[];
}

export interface PartnerTrade {
  code: number;
  imports: number;
  exports: number;
}

/** Fold Comtrade rows (one per partner and flow) into one row per partner. Partner 0 is the world total. */
export function foldPartners(rows: ComtradeRow[]): { world: PartnerTrade; partners: PartnerTrade[] } {
  const m = new Map<number, PartnerTrade>();
  for (const r of rows) {
    if (typeof r.partnerCode !== 'number' || typeof r.primaryValue !== 'number') continue;
    const p = m.get(r.partnerCode) ?? { code: r.partnerCode, imports: 0, exports: 0 };
    if (r.flowCode === 'M') p.imports += r.primaryValue;
    else if (r.flowCode === 'X') p.exports += r.primaryValue;
    else continue;
    m.set(r.partnerCode, p);
  }
  const world = m.get(0) ?? { code: 0, imports: 0, exports: 0 };
  m.delete(0);
  const partners = [...m.values()].sort((a, b) => b.imports + b.exports - (a.imports + a.exports));
  return { world, partners };
}

const tradePartners: CardDef = {
  id: 'macro.trade-partners',
  title: 'Trade Partners',
  source: 'UN Comtrade',
  description: "One country's goods imports, exports and balance with its largest trading partners for the latest full year reported.",
  params: [{ name: 'country', label: 'Reporting country', default: 'US', hint: 'ISO-2 code, e.g. US, CN, DE' }],
  async run(ctx, p) {
    const eco = resolveEconomy(p.country);
    if (eco.iso2 === 'XM') throw new SourceError('UN Comtrade', 'pick a single country: Comtrade has no euro-area reporter');
    const ref = (url: string): Promise<ComtradeRef> => ctx.http.json<ComtradeRef>(url, { source: 'UN Comtrade', ttl: 86400 * 7, timeoutMs: 40_000 });
    const [reporters, partnersRef] = await Promise.all([ref('https://comtradeapi.un.org/files/v1/app/reference/Reporters.json'), ref('https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json')]);
    const reporter = (reporters.results ?? []).find((r) => r.reporterCodeIsoAlpha2 === eco.iso2 && !r.isGroup && !r.entryExpiredDate) ?? (reporters.results ?? []).find((r) => r.reporterCodeIsoAlpha2 === eco.iso2);
    if (!reporter || typeof reporter.id !== 'number') throw new SourceError('UN Comtrade', `no reporter for ${eco.name} (${eco.iso2})`);
    const names = new Map((partnersRef.results ?? []).map((r) => [r.id as number, r.text ?? String(r.id)]));
    const year = ctx.now().getUTCFullYear();
    let data: ComtradeRow[] = [];
    let period = '';
    const tried: string[] = [];
    for (const y of [year - 1, year - 2, year - 3]) {
      const url = `https://comtradeapi.un.org/public/v1/preview/C/A/HS?reporterCode=${reporter.id}&period=${y}&cmdCode=TOTAL&flowCode=M,X`;
      const body = await ctx.http.json<{ data?: ComtradeRow[]; error?: string }>(url, { source: 'UN Comtrade', ttl: 21600, timeoutMs: 40_000 });
      if (body.data?.length) {
        data = body.data;
        period = String(y);
        break;
      }
      tried.push(String(y));
    }
    if (!data.length) throw new SourceError('UN Comtrade', `${eco.name} has not reported ${tried.join(', ')}`);
    const { world, partners } = foldPartners(data);
    const total = world.imports + world.exports;
    const rows: Row[] = partners.slice(0, 25).map((t) => ({
      partner: names.get(t.code) ?? `Area ${t.code}`,
      exports: t.exports,
      imports: t.imports,
      balance: t.exports - t.imports,
      share: total > 0 ? ((t.imports + t.exports) / total) * 100 : null,
    }));
    const notes = ['Goods only, in U.S. dollars as reported by the country: imports usually include freight and insurance, exports do not, so balances differ from the partner\'s own figures.', "Uses Comtrade's keyless preview service, which returns at most 500 records per request."];
    if (tried.length) notes.push(`Not yet reported: ${tried.join(', ')}.`);
    return {
      blocks: [
        {
          kind: 'stats',
          title: `${eco.name}, ${period}`,
          items: [
            { label: 'Exports', value: world.exports, format: 'usdCompact' },
            { label: 'Imports', value: world.imports, format: 'usdCompact' },
            { label: 'Balance', value: world.exports - world.imports, format: 'usdCompact' },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'partner', label: 'Partner', maxWidth: 32 },
            { key: 'exports', label: 'Exports', format: 'usdCompact' },
            { key: 'imports', label: 'Imports', format: 'usdCompact' },
            { key: 'balance', label: 'Balance', format: 'usdCompact' },
            { key: 'share', label: 'Share of trade', format: 'pct', digits: 1 },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://comtradeplus.un.org/',
      asOf: period,
      notes,
    };
  },
};

export const tradeCards: CardDef[] = [chokepoints, chokepointHistory, diversion, ports, disruptions, tradePartners];

export const tradeDashboard: DashboardDef = {
  id: 'trade',
  title: 'Trade & Shipping',
  group: 'Macro & Economy',
  tabs: [
    { id: 'chokepoints', title: 'Chokepoints', cards: ['macro.chokepoints', 'macro.chokepoint-history', 'macro.red-sea-diversion'] },
    { id: 'ports', title: 'Ports', cards: ['macro.ports', 'macro.port-disruptions'] },
    { id: 'trade', title: 'Trade', cards: ['macro.trade-partners'] },
  ],
};
