/** Data Explorers: find a series at FRED, BLS, the IMF, the OECD, the ECB or the BIS and plot it. */
import { fredSeries } from '../../lib/fred.js';
import { MissingKeyError, SourceError, type Block, type CardDef, type CardResult, type DashboardDef, type ParamSpec, type Row } from '../../types.js';
import { BLS_KEYLESS_NOTE, blsSeries, changeOver } from './bls.js';
import { nameOf, resolveEconomy } from './countries.js';
import { bisData, ecbData, imfIndicator, imfIndicators, imfPoints, oecdData, RANGE_CHOICES, rangeStartMs, type Point, type SdmxObs } from './data.js';
import { decodeEntities } from './rss.js';

const RANGE: ParamSpec = { name: 'range', label: 'Range', default: '10Y', choices: RANGE_CHOICES };

/** A chart, a short summary and the latest observations for one or more series. */
function seriesBlocks(lines: { name: string; points: Point[]; periods?: string[] }[], opts: { title?: string; digits?: number } = {}): Block[] {
  const digits = opts.digits ?? 2;
  const first = lines[0];
  const last = first.points[first.points.length - 1];
  const prev = first.points[first.points.length - 2];
  const label = (i: number): string => first.periods?.[i] ?? new Date(first.points[i][0]).toISOString().slice(0, 10);
  const values = first.points.map((p) => p[1]);
  const blocks: Block[] = [
    {
      kind: 'stats',
      items: [
        { label: 'Latest', value: last[1], format: 'num', digits },
        { label: 'Period', value: label(first.points.length - 1) },
        { label: 'Change on previous', value: prev ? last[1] - prev[1] : null, format: 'signed', digits },
        { label: 'High in range', value: Math.max(...values), format: 'num', digits },
        { label: 'Low in range', value: Math.min(...values), format: 'num', digits },
        { label: 'Observations', value: first.points.length, format: 'int' },
      ],
    },
    { kind: 'chart', title: opts.title, xType: 'time', series: lines.map((l) => ({ name: l.name, points: l.points })), yFormat: 'num', yDigits: digits },
  ];
  const rows: Row[] = [];
  for (let i = first.points.length - 1; i >= 0 && rows.length < 12; i--) rows.push({ period: label(i), value: first.points[i][1], change: i > 0 ? first.points[i][1] - first.points[i - 1][1] : null });
  blocks.push({ kind: 'table', title: lines.length > 1 ? first.name : undefined, columns: [{ key: 'period', label: 'Period' }, { key: 'value', label: 'Value', format: 'num', digits }, { key: 'change', label: 'Change', format: 'signed', digits }], rows });
  return blocks;
}

interface FredSearchBody {
  seriess?: { id?: string; title?: string; frequency_short?: string; units_short?: string; seasonal_adjustment_short?: string; observation_end?: string; popularity?: number }[];
  error_message?: string;
}

export function parseFredSearch(body: FredSearchBody): Row[] {
  return (body.seriess ?? [])
    .filter((s) => s.id)
    .map((s) => ({ id: s.id, title: s.title ?? '', freq: s.frequency_short ?? '', units: s.units_short ?? '', sa: s.seasonal_adjustment_short ?? '', last: s.observation_end ?? '', popularity: s.popularity ?? null }));
}

const fredSearch: CardDef = {
  id: 'macro.fred-search',
  title: 'FRED Series Search',
  source: 'FRED',
  description: 'Search the St. Louis Fed database by keyword; plot a result with the FRED Series card.',
  needsKey: 'FRED',
  params: [{ name: 'query', label: 'Search', default: 'unemployment rate', hint: 'keywords, e.g. core pce' }],
  async run(ctx, p) {
    const key = ctx.key('FRED');
    if (!key) throw new MissingKeyError('FRED');
    const q = (p.query ?? '').trim() || 'unemployment rate';
    const url = `https://api.stlouisfed.org/fred/series/search?search_text=${encodeURIComponent(q)}&api_key=${encodeURIComponent(key)}&file_type=json&limit=30&order_by=popularity&sort_order=desc`;
    const rows = parseFredSearch(await ctx.http.json<FredSearchBody>(url, { source: 'FRED', ttl: 3600 }));
    if (!rows.length) throw new SourceError('FRED', `no series match "${q}"`);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [{ key: 'id', label: 'Series' }, { key: 'title', label: 'Title', maxWidth: 70 }, { key: 'freq', label: 'Freq' }, { key: 'units', label: 'Units', maxWidth: 22 }, { key: 'sa', label: 'Adj' }, { key: 'last', label: 'Latest' }, { key: 'popularity', label: 'Popularity', format: 'int' }],
          rows,
          footnote: 'Pass a Series id to the FRED Series card to plot it.',
        },
      ],
      sourceUrl: `https://fred.stlouisfed.org/searchresults/?st=${encodeURIComponent(q)}`,
      notes: ['Most popular matches first.'],
    };
  },
};

const fredPlot: CardDef = {
  id: 'macro.fred-series',
  title: 'FRED Series',
  source: 'FRED',
  description: 'Plot any FRED series by id.',
  params: [{ name: 'series', label: 'Series id', default: 'UNRATE', hint: 'FRED id, e.g. UNRATE, DGS10, CPIAUCSL' }, RANGE],
  async run(ctx, p) {
    const id = (p.series ?? 'UNRATE').trim().toUpperCase();
    if (!/^[A-Z0-9_.\-]{1,40}$/.test(id)) throw new SourceError('FRED', `not a series id: ${p.series}`);
    const start = new Date(Math.max(rangeStartMs(p.range, ctx.now(), '10Y'), Date.UTC(1900, 0, 1))).toISOString().slice(0, 10);
    const s = await fredSeries(ctx, id, { start });
    if (!s.points.length) throw new SourceError('FRED', `no observations for ${id}`);
    const notes = s.source === 'FRED' ? [] : ['No FRED key set: read from the public chart download, which some networks cannot reach.'];
    return { blocks: seriesBlocks([{ name: id, points: s.points }], { title: id }), source: s.source, sourceUrl: `https://fred.stlouisfed.org/series/${id}`, asOf: new Date(s.points[s.points.length - 1][0]).toISOString().slice(0, 10), notes };
  },
};

const blsPlot: CardDef = {
  id: 'macro.bls-series',
  title: 'BLS Series',
  source: 'BLS',
  description: 'Plot any BLS time series by id (CPI, PPI, employment, JOLTS, productivity and more).',
  params: [{ name: 'series', label: 'Series id', default: 'LNS14000000', hint: 'BLS id, e.g. LNS14000000 (unemployment rate), CUUR0000SA0 (CPI)' }],
  async run(ctx, p) {
    const id = (p.series ?? 'LNS14000000').trim().toUpperCase();
    if (!/^[A-Z0-9_#\-]{4,40}$/.test(id)) throw new SourceError('BLS', `not a series id: ${p.series}`);
    const year = ctx.now().getUTCFullYear();
    const { series, keyed } = await blsSeries(ctx, [id], year - 9, year);
    const list = series.get(id) ?? [];
    if (!list.length) throw new SourceError('BLS', `no observations for ${id} (check the series id)`);
    const blocks = seriesBlocks([{ name: id, points: list.map((o) => [o.t, o.value]), periods: list.map((o) => o.period) }], { title: id });
    const yoy = changeOver(list, 12);
    if (blocks[0].kind === 'stats') blocks[0].items.push({ label: '12-month % change', value: yoy, format: 'signedPct', digits: 1 });
    return { blocks, sourceUrl: `https://data.bls.gov/timeseries/${id}`, asOf: list[list.length - 1].period, notes: [keyed ? 'Up to 20 years with a BLS key.' : `The last ten years. ${BLS_KEYLESS_NOTE}`] };
  },
};

const imfList: CardDef = {
  id: 'macro.imf-indicators',
  title: 'IMF Indicator Search',
  source: 'IMF',
  description: 'Search the IMF DataMapper indicator list; plot a result with the IMF Series card.',
  params: [{ name: 'query', label: 'Search', default: 'gdp', hint: 'word in the indicator name or code, e.g. debt, inflation' }],
  async run(ctx, p) {
    const all = await imfIndicators(ctx);
    const q = (p.query ?? '').trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const rows: Row[] = Object.entries(all)
      .filter(([code, i]) => {
        const hay = `${code} ${i.label} ${i.dataset}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .map(([code, i]) => ({ code, label: i.label, unit: i.unit, dataset: i.dataset || i.source }))
      .sort((a, b) => Number(String(b.dataset).startsWith('WEO')) - Number(String(a.dataset).startsWith('WEO')) || String(a.label).localeCompare(String(b.label)));
    if (!rows.length) throw new SourceError('IMF', `no indicator matches "${p.query}"`);
    return {
      blocks: [{ kind: 'table', columns: [{ key: 'code', label: 'Indicator' }, { key: 'label', label: 'Name', maxWidth: 70 }, { key: 'unit', label: 'Unit', maxWidth: 34 }, { key: 'dataset', label: 'Dataset', maxWidth: 30 }], rows: rows.slice(0, 40), footnote: `${rows.length} of ${Object.keys(all).length} indicators match. Pass an Indicator code to the IMF Series card.` }],
      sourceUrl: 'https://www.imf.org/external/datamapper',
      notes: ['World Economic Outlook indicators are listed first.'],
    };
  },
};

const imfPlot: CardDef = {
  id: 'macro.imf-series',
  title: 'IMF Series',
  source: 'IMF',
  description: 'Plot one IMF DataMapper indicator for a country.',
  params: [
    { name: 'series', label: 'Indicator', default: 'NGDP_RPCH', hint: 'IMF indicator code, e.g. NGDP_RPCH, PCPIPCH, GGXWDG_NGDP' },
    { name: 'country', label: 'Country', default: 'US', hint: 'ISO-2 code, e.g. US, DE, JP, or XM for the euro area' },
  ],
  async run(ctx, p) {
    const code = (p.series ?? 'NGDP_RPCH').trim().toUpperCase();
    const eco = resolveEconomy(p.country);
    const [table, info] = await Promise.all([imfIndicator(ctx, code), imfIndicators(ctx).catch(() => ({}) as Awaited<ReturnType<typeof imfIndicators>>)]);
    const points = imfPoints(table, eco.imf);
    if (!points.length) throw new SourceError('IMF', `${code} has no data for ${eco.name} (${eco.imf})`);
    const meta = info[code];
    const year = ctx.now().getUTCFullYear();
    const notes = ['Annual data. Where the indicator is a World Economic Outlook series, the current and later years are IMF projections.'];
    if (meta?.source) notes.unshift(`Vintage: ${meta.source}.`);
    if (meta?.unit) notes.unshift(`Unit: ${meta.unit}.`);
    // Summary and table stop at the current year; later years are drawn as a separate projection line.
    const cut = Date.UTC(year, 0, 1);
    const past = points.filter((pt) => pt[0] <= cut);
    const future = points.filter((pt) => pt[0] >= cut);
    const shown = past.length ? past : points;
    const lines = [{ name: eco.name, points: shown, periods: shown.map((pt) => String(new Date(pt[0]).getUTCFullYear())) }];
    if (past.length && future.length > 1) lines.push({ name: 'Projection', points: future, periods: [] });
    const blocks = seriesBlocks(lines, { title: `${meta?.label ?? code}: ${eco.name}` });
    return { blocks, sourceUrl: `https://www.imf.org/external/datamapper/${code}`, asOf: String(Math.min(year, new Date(points[points.length - 1][0]).getUTCFullYear())), notes };
  },
};

export interface OecdFlow {
  ref: string;
  name: string;
}

/** Dataflow ids and English names from an SDMX 2.1 structure message. */
export function parseDataflows(xml: string): OecdFlow[] {
  const out: OecdFlow[] = [];
  const re = /<(?:\w+:)?Dataflow\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Dataflow>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const agency = /\bagencyID="([^"]+)"/.exec(attrs)?.[1];
    const version = /\bversion="([^"]+)"/.exec(attrs)?.[1];
    if (!id || !agency) continue;
    const name = /<(?:\w+:)?Name\b[^>]*xml:lang="en"[^>]*>([\s\S]*?)<\/(?:\w+:)?Name>/.exec(m[2])?.[1] ?? /<(?:\w+:)?Name\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Name>/.exec(m[2])?.[1] ?? id;
    out.push({ ref: `${agency},${id},${version ?? ''}`, name: decodeEntities(name).trim() });
  }
  return out;
}

const oecdList: CardDef = {
  id: 'macro.oecd-dataflows',
  title: 'OECD Dataset Search',
  source: 'OECD',
  description: 'Search the OECD Data Explorer catalogue of datasets; plot a series with the OECD Series card.',
  params: [{ name: 'query', label: 'Search', default: 'leading indicators', hint: 'words in the dataset name, e.g. unemployment, house prices' }],
  async run(ctx, p) {
    const xml = await ctx.http.text('https://sdmx.oecd.org/public/rest/dataflow/all?detail=allstubs', { source: 'OECD', ttl: 86400, timeoutMs: 45_000, headers: { accept: 'application/vnd.sdmx.structure+xml; charset=utf-8; version=2.1' } });
    const flows = parseDataflows(xml);
    if (!flows.length) throw new SourceError('OECD', 'the dataset catalogue could not be read');
    const words = (p.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = flows.filter((f) => words.every((w) => `${f.name} ${f.ref}`.toLowerCase().includes(w))).sort((a, b) => a.name.localeCompare(b.name));
    if (!hits.length) throw new SourceError('OECD', `no dataset matches "${p.query}"`);
    return {
      blocks: [{ kind: 'table', columns: [{ key: 'name', label: 'Dataset', maxWidth: 80 }, { key: 'ref', label: 'Dataflow', maxWidth: 70 }], rows: hits.slice(0, 40).map((f) => ({ name: f.name, ref: f.ref })), footnote: `${hits.length} of ${flows.length} datasets match. A series is "Dataflow/key": the dataflow, a slash, then the dotted dimension filter shown by the Data Explorer's developer API panel.` }],
      sourceUrl: 'https://data-explorer.oecd.org/',
    };
  },
};

const SDMX_META = new Set(['STRUCTURE', 'STRUCTURE_ID', 'ACTION', 'KEY']);

/** Split SDMX-CSV rows into series: the dimension columns sit between ACTION and TIME_PERIOD. */
export function splitSeries(obs: SdmxObs[]): { key: string; title: string; points: Point[]; periods: string[] }[] {
  const m = new Map<string, { key: string; title: string; points: Point[]; periods: string[] }>();
  for (const o of obs) {
    const cols = Object.keys(o.dims);
    const end = cols.indexOf('TIME_PERIOD');
    const dims = cols.slice(0, end < 0 ? 0 : end).filter((c) => !SDMX_META.has(c));
    const key = o.dims.KEY || dims.map((c) => o.dims[c]).join('.');
    let s = m.get(key);
    if (!s) {
      s = { key, title: (o.dims.TITLE || o.dims.TITLE_COMPL || '').trim(), points: [], periods: [] };
      m.set(key, s);
    }
    s.points.push([o.t, o.value]);
    s.periods.push(o.period);
  }
  return [...m.values()];
}

function sdmxResult(obs: SdmxObs[], what: string, source: string, sourceUrl: string): CardResult {
  const all = splitSeries(obs).filter((s) => s.points.length);
  if (!all.length) throw new SourceError(source, `no observations for ${what}`);
  const shown = all.slice(0, 6);
  const notes: string[] = [];
  if (all.length > shown.length) notes.push(`The key matches ${all.length} series; the first ${shown.length} are plotted. Narrow the key to pick one.`);
  if (shown[0].title) notes.push(shown[0].title);
  const area = obs[0]?.dims.REF_AREA;
  const lines = shown.map((s) => ({ name: all.length === 1 ? (s.title ? s.key : area ? `${nameOf(area)} (${s.key})` : s.key) : s.key, points: s.points, periods: s.periods }));
  return { blocks: seriesBlocks(lines, { title: what }), sourceUrl, asOf: shown[0].periods[shown[0].periods.length - 1], notes };
}

function startYear(range: string | undefined, now: Date): number {
  return Math.max(new Date(rangeStartMs(range, now, '10Y')).getUTCFullYear(), 1900);
}

const oecdPlot: CardDef = {
  id: 'macro.oecd-series',
  title: 'OECD Series',
  source: 'OECD',
  description: 'Plot a series from any OECD dataset, given as "dataflow/key".',
  params: [{ name: 'series', label: 'Dataflow/key', default: 'OECD.SDD.STES,DSD_STES@DF_CLI,4.1/USA.M.LI...AA...H', hint: 'dataflow, a slash, then the dotted dimension filter' }, RANGE],
  async run(ctx, p) {
    const raw = (p.series ?? '').trim();
    const cut = raw.indexOf('/');
    if (cut <= 0 || cut === raw.length - 1 || !/^[\w.@,\-]+$/.test(raw.slice(0, cut)) || !/^[\w.+*\-]+$/.test(raw.slice(cut + 1))) throw new SourceError('OECD', 'series must look like "OECD.SDD.STES,DSD_STES@DF_CLI,4.1/USA.M.LI...AA...H"');
    const obs = await oecdData(ctx, raw.slice(0, cut), raw.slice(cut + 1), `startPeriod=${startYear(p.range, ctx.now())}`, 3600);
    return sdmxResult(obs, raw.slice(cut + 1), 'OECD', 'https://data-explorer.oecd.org/');
  },
};

const ecbPlot: CardDef = {
  id: 'macro.ecb-series',
  title: 'ECB Series',
  source: 'ECB',
  description: 'Plot a series from the ECB Data Portal by its series key.',
  params: [{ name: 'series', label: 'Series key', default: 'EXR.D.USD.EUR.SP00.A', hint: 'ECB series key, e.g. EXR.D.USD.EUR.SP00.A, FM.B.U2.EUR.4F.KR.DFR.LEV, ICP.M.U2.N.000000.4.ANR' }, RANGE],
  async run(ctx, p) {
    const raw = (p.series ?? '').trim().toUpperCase();
    const cut = raw.indexOf('.');
    if (cut <= 0 || !/^[A-Z0-9_]+$/.test(raw.slice(0, cut)) || !/^[A-Z0-9_.+\-]+$/.test(raw.slice(cut + 1))) throw new SourceError('ECB', 'series must look like "EXR.D.USD.EUR.SP00.A"');
    const obs = await ecbData(ctx, raw.slice(0, cut), raw.slice(cut + 1), `startPeriod=${startYear(p.range, ctx.now())}`);
    return sdmxResult(obs, raw, 'ECB', `https://data.ecb.europa.eu/data/datasets/${raw.slice(0, cut)}/${raw}`);
  },
};

const bisPlot: CardDef = {
  id: 'macro.bis-series',
  title: 'BIS Series',
  source: 'BIS',
  description: 'Plot a series from a BIS statistical dataset, given as "dataflow/key".',
  params: [{ name: 'series', label: 'Dataflow/key', default: 'WS_CBPOL/M.US', hint: 'e.g. WS_CBPOL/M.US (policy rate), WS_EER/M.N.B.US (effective exchange rate), WS_SPP/Q.US.N.628 (house prices)' }, RANGE],
  async run(ctx, p) {
    const raw = (p.series ?? '').trim().toUpperCase();
    const cut = raw.indexOf('/');
    if (cut <= 0 || cut === raw.length - 1 || !/^[A-Z0-9_]+$/.test(raw.slice(0, cut)) || !/^[A-Z0-9_.+*\-]+$/.test(raw.slice(cut + 1))) throw new SourceError('BIS', 'series must look like "WS_CBPOL/M.US"');
    const obs = await bisData(ctx, raw.slice(0, cut), raw.slice(cut + 1), `startPeriod=${startYear(p.range, ctx.now())}`);
    return sdmxResult(obs, raw, 'BIS', `https://data.bis.org/topics`);
  },
};

export const explorerCards: CardDef[] = [imfList, imfPlot, blsPlot, oecdList, oecdPlot, ecbPlot, bisPlot, fredPlot, fredSearch];

export const explorersDashboard: DashboardDef = {
  id: 'explorers',
  title: 'Data Explorers',
  group: 'Macro & Economy',
  tabs: [{ id: 'search', title: 'Search', cards: explorerCards.map((c) => c.id) }],
};
