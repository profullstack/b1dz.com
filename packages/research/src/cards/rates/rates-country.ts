/** Rates & Curves: the Global tab and the By Country tab. */
import { csvObjects } from '../../http.js';
import { SourceError, type Block, type CardDef, type Column, type Ctx, type Row } from '../../types.js';
import { countryCurve, oecdRates } from './curves.js';
import {
  COUNTRIES,
  HORIZONS,
  RANGE_CHOICES,
  bisArea,
  bpDiff,
  countryBy,
  curveAt,
  latestDate,
  rangeStart,
  shiftBack,
  sortPoints,
  timePoints,
  ymd,
  DAY,
  type Horizon,
} from './util.js';

/** Countries the OECD monthly set covers (the rest of COUNTRIES is BIS-only). */
const OECD_CODES = COUNTRIES.slice(0, COUNTRIES.findIndex((c) => c.iso2 === 'AR')).map((c) => c.iso2);
const ALL_CODES = COUNTRIES.map((c) => c.iso2);

const countryParam = (choices: string[]) => ({ name: 'country', label: 'Country', default: 'US', choices, hint: 'ISO-2 code; EA = euro area' });

export function parseHorizons(raw: string | undefined, fallback: Horizon[] = ['1M', '1Y']): Horizon[] {
  const want = (raw ?? '').toUpperCase().split(/[\s,]+/).filter(Boolean);
  const out = HORIZONS.filter((h) => want.includes(h));
  return out.length ? out : fallback;
}

// ---------- BIS policy rates ----------

async function bisPolicy(ctx: Ctx, key: string, start: string, ttl = 21_600): Promise<Map<string, [string, number][]>> {
  const url = `https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/${key}?startPeriod=${start}&format=csv&detail=dataonly`;
  return parsePolicyCsv(await ctx.http.text(url, { source: 'BIS', ttl, timeoutMs: 45_000 }));
}

/** BIS policy-rate CSV (REF_AREA, TIME_PERIOD, OBS_VALUE) to a series per area. */
export function parsePolicyCsv(text: string): Map<string, [string, number][]> {
  const out = new Map<string, [string, number][]>();
  for (const r of csvObjects(text)) {
    const v = Number(r.OBS_VALUE);
    if (!r.REF_AREA || !r.TIME_PERIOD || r.OBS_VALUE === '' || !Number.isFinite(v)) continue;
    let list = out.get(r.REF_AREA);
    if (!list) out.set(r.REF_AREA, (list = []));
    list.push([r.TIME_PERIOD, v]);
  }
  for (const [k, v] of out) out.set(k, sortPoints(v));
  return out;
}

export interface RateChange {
  date: string;
  from: number;
  to: number;
}

/** Every step in a policy-rate series, oldest first. */
export function rateChanges(points: [string, number][]): RateChange[] {
  const out: RateChange[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i][1] !== points[i - 1][1]) out.push({ date: points[i][0], from: points[i - 1][1], to: points[i][1] });
  }
  return out;
}

const policyRates: CardDef = {
  id: 'rates.policy-rates',
  title: 'Central Bank Policy Rates',
  source: 'BIS',
  description: 'Policy rate for about forty central banks with the date, size and direction of the last change.',
  async run(ctx) {
    const now = ctx.now();
    const daily = await bisPolicy(ctx, 'D.', shiftBack(ymd(now), '2Y'));
    const monthly = await bisPolicy(ctx, 'M.', '2010-01');
    const fresh = ymd(now.getTime() - 60 * DAY);
    const rows: Row[] = [];
    let asOf = '';
    for (const [area, points] of daily) {
      const last = points[points.length - 1];
      if (!last || last[0] < fresh) continue;
      if (last[0] > asOf) asOf = last[0];
      let change = rateChanges(points).pop();
      let approx = false;
      if (!change) {
        change = rateChanges(monthly.get(area) ?? []).pop();
        approx = true;
      }
      const name = area === 'XM' ? 'Euro area (ECB)' : (countryBy(area)?.name ?? area);
      const move = change ? bpDiff(change.to, change.from) : null;
      rows.push({
        bank: name,
        code: area === 'XM' ? 'EA' : area,
        rate: last[1],
        changed: change ? (approx ? change.date.slice(0, 7) : change.date) : 'before 2010',
        direction: move == null ? '' : move > 0 ? 'Hike' : 'Cut',
        move,
        previous: change?.from ?? null,
      });
    }
    if (!rows.length) throw new SourceError('BIS', 'no current policy rates in the response');
    rows.sort((a, b) => String(b.changed).localeCompare(String(a.changed)));
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'bank', label: 'Central bank' },
            { key: 'code', label: 'Code' },
            { key: 'rate', label: 'Policy rate', format: 'pct', digits: 2 },
            { key: 'changed', label: 'Last change' },
            { key: 'direction', label: 'Direction' },
            { key: 'move', label: 'Step', format: 'bp' },
            { key: 'previous', label: 'Before', format: 'pct', digits: 2 },
          ],
          rows,
          footnote: 'Most recent mover first. A month without a day means the last change is older than two years and is dated from monthly data.',
        },
      ],
      sourceUrl: 'https://data.bis.org/topics/CBPOL',
      asOf,
      notes: ['BIS compiles one representative policy rate per central bank; for target ranges it reports the mid-point (U.S.: middle of the federal funds range).'],
    };
  },
};

const policyHistory: CardDef = {
  id: 'rates.policy-history',
  title: 'Policy Rate History',
  source: 'BIS',
  description: 'Central bank policy rate through time for one country, with its recent changes.',
  params: [countryParam(ALL_CODES), { name: 'range', label: 'Range', default: '10Y', choices: [...RANGE_CHOICES, 'MAX'] }],
  async run(ctx, p) {
    const c = countryBy(p.country);
    if (!c) throw new SourceError('BIS', `unknown country code ${p.country}`);
    const area = bisArea(c.iso2);
    const start = rangeStart(p.range, ctx.now(), '1950-01-01');
    const points = (await bisPolicy(ctx, `D.${area}`, start, 3600)).get(area) ?? [];
    if (!points.length) throw new SourceError('BIS', `no policy rate series for ${c.name}`);
    const changes = rateChanges(points).reverse().slice(0, 15);
    const last = points[points.length - 1];
    const blocks: Block[] = [
      {
        kind: 'chart',
        title: `${area === 'XM' ? 'ECB' : c.name} policy rate`,
        xType: 'time',
        series: [{ name: 'Policy rate', points: timePoints(points) }],
        yFormat: 'pct',
        yDigits: 2,
      },
      {
        kind: 'table',
        title: 'Changes, newest first',
        columns: [
          { key: 'date', label: 'Date', format: 'date' },
          { key: 'to', label: 'New rate', format: 'pct', digits: 2 },
          { key: 'move', label: 'Step', format: 'bp' },
          { key: 'from', label: 'Before', format: 'pct', digits: 2 },
        ],
        rows: changes.map((x) => ({ date: x.date, to: x.to, move: bpDiff(x.to, x.from), from: x.from })),
        footnote: changes.length ? undefined : 'No change inside the selected range.',
      },
    ];
    const notes = area === 'XM' && c.iso2 !== 'EA' ? [`${c.name} is in the euro area: this is the ECB's rate.`] : [];
    return { blocks, sourceUrl: 'https://data.bis.org/topics/CBPOL', asOf: last[0], notes: [`Current rate ${last[1]}%.`, ...notes] };
  },
};

// ---------- OECD monthly rates ----------

const globalYields: CardDef = {
  id: 'rates.global-yields',
  title: 'Global Yields Matrix',
  source: 'OECD',
  description: '3-month and 10-year rates for about forty-five countries with the slope and the 10-year change over one and twelve months.',
  async run(ctx) {
    const got = await oecdRates(ctx, '', { last: 14 });
    const rows: Row[] = [];
    let asOf = '';
    for (const iso3 of new Set([...got.long.keys(), ...got.short.keys()])) {
      const long = got.long.get(iso3) ?? [];
      const short = got.short.get(iso3) ?? [];
      const l = long[long.length - 1];
      const s = short[short.length - 1];
      const period = l?.[0] ?? s?.[0] ?? '';
      if (period > asOf) asOf = period;
      const at = (months: number) => (l ? long.find(([d]) => d === shiftBack(`${l[0]}-01`, `${months}M`).slice(0, 7))?.[1] : undefined);
      rows.push({
        country: iso3 === 'EA20' ? 'Euro area' : (countryBy(iso3)?.name ?? iso3),
        code: countryBy(iso3)?.iso2 ?? iso3,
        short: s && l && s[0] !== l[0] ? null : (s?.[1] ?? null),
        long: l?.[1] ?? null,
        slope: s && l && s[0] === l[0] ? bpDiff(l[1], s[1]) : null,
        d1m: l ? bpDiff(l[1], at(1)) : null,
        d12m: l ? bpDiff(l[1], at(12)) : null,
        period,
      });
    }
    // Series the OECD no longer updates (their last month is long past) are left out.
    const cutoff = shiftBack(`${asOf}-01`, '4M').slice(0, 7);
    const current = rows.filter((r) => String(r.period) >= cutoff);
    current.sort((a, b) => Number(b.long ?? -99) - Number(a.long ?? -99));
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'country', label: 'Country' },
            { key: 'code', label: 'Code' },
            { key: 'short', label: '3M', format: 'pct', digits: 2 },
            { key: 'long', label: '10Y', format: 'pct', digits: 2 },
            { key: 'slope', label: '10Y-3M', format: 'bp' },
            { key: 'd1m', label: '10Y 1M chg', format: 'bp' },
            { key: 'd12m', label: '10Y 12M chg', format: 'bp' },
            { key: 'period', label: 'Month' },
          ],
          rows: current,
          footnote: 'Sorted by 10-year yield. A blank 3M means the short rate is not published for the same month.',
        },
      ],
      sourceUrl: 'https://data-explorer.oecd.org/vis?df[ds]=dsDisseminateFinalDMZ&df[id]=DSD_STES%40DF_FINMARK&df[ag]=OECD.SDD.STES',
      asOf,
      notes: ['Monthly averages: 3-month interbank rate and long-term (about 10-year) government bond yield. Use the By Country tab for daily official curves.'],
    };
  },
};

const longRateHistory: CardDef = {
  id: 'rates.long-rate-history',
  title: 'Long-term and 3-month Rate History',
  source: 'OECD',
  description: 'Monthly 10-year government bond yield and 3-month interbank rate for one country.',
  params: [countryParam(OECD_CODES), { name: 'range', label: 'Range', default: '10Y', choices: [...RANGE_CHOICES, 'MAX'] }],
  async run(ctx, p) {
    const c = countryBy(p.country);
    if (!c) throw new SourceError('OECD', `unknown country code ${p.country}`);
    const got = await oecdRates(ctx, c.iso3, { start: rangeStart(p.range, ctx.now(), '1960-01-01') });
    const long = got.long.get(c.iso3) ?? [];
    const short = got.short.get(c.iso3) ?? [];
    const series = [
      { name: '10Y government bond', points: timePoints(long) },
      { name: '3M interbank', points: timePoints(short) },
    ].filter((s) => s.points.length);
    const l = long[long.length - 1];
    const s = short[short.length - 1];
    const yearAgo = (pts: [string, number][], last?: [string, number]) => (last ? pts.find(([d]) => d === shiftBack(`${last[0]}-01`, '1Y').slice(0, 7))?.[1] : undefined);
    return {
      blocks: [
        { kind: 'chart', title: `${c.name}: monthly rates`, xType: 'time', series, yFormat: 'pct', yDigits: 2 },
        {
          kind: 'stats',
          items: [
            { label: `10Y (${l?.[0] ?? 'n/a'})`, value: l?.[1], format: 'pct' },
            { label: '10Y change, 12 months', value: bpDiff(l?.[1], yearAgo(long, l)), format: 'bp' },
            { label: `3M (${s?.[0] ?? 'n/a'})`, value: s?.[1], format: 'pct' },
            { label: '3M change, 12 months', value: bpDiff(s?.[1], yearAgo(short, s)), format: 'bp' },
            { label: '10Y minus 3M', value: l && s && l[0] === s[0] ? bpDiff(l[1], s[1]) : null, format: 'bp' },
          ],
        },
      ],
      sourceUrl: 'https://data-explorer.oecd.org/vis?df[ds]=dsDisseminateFinalDMZ&df[id]=DSD_STES%40DF_FINMARK&df[ag]=OECD.SDD.STES',
      asOf: l?.[0] ?? s?.[0],
      notes: ['Monthly averages, not end-of-month closes.'],
    };
  },
};

// ---------- Sovereign curve ----------

interface CurveSnapshot {
  label: string;
  date: string;
  values: (number | null)[];
}

async function snapshots(ctx: Ctx, country: string, horizons: Horizon[]) {
  const today = ymd(ctx.now());
  const data = await countryCurve(ctx, country, [today, ...horizons.map((h) => shiftBack(today, h))]);
  const latest = latestDate(data.series);
  if (!latest) throw new SourceError(data.source, 'the curve has no observations');
  const now = curveAt(data.series, latest, data.maxStaleDays);
  const past: CurveSnapshot[] = horizons.map((h) => {
    const at = curveAt(data.series, shiftBack(latest, h), data.maxStaleDays);
    return { label: h, date: at.date, values: at.values };
  });
  return { data, latest, now, past };
}

const curve: CardDef = {
  id: 'rates.curve',
  title: 'Sovereign Yield Curve',
  source: 'Official sources',
  description: "Today's government yield curve from the country's official publisher against earlier dates.",
  params: [
    countryParam(OECD_CODES),
    { name: 'compare', label: 'Compare with', default: '1M,1Y', hint: 'any of 1M 3M 6M 1Y 2Y 5Y, comma separated' },
  ],
  async run(ctx, p) {
    const horizons = parseHorizons(p.compare);
    const { data, latest, now, past } = await snapshots(ctx, p.country, horizons);
    const name = countryBy(p.country)?.name ?? p.country;
    const line = (values: (number | null)[]): [number, number][] =>
      data.series.flatMap((s, i): [number, number][] => (values[i] == null ? [] : [[s.years, values[i] as number]]));
    const shown = past.filter((s) => s.values.some((v) => v != null));
    const columns: Column[] = [
      { key: 'tenor', label: 'Tenor' },
      { key: 'now', label: latest, format: 'pct', digits: 2 },
    ];
    for (const s of shown) {
      columns.push({ key: `y${s.label}`, label: `${s.label} ago`, format: 'pct', digits: 2 });
      columns.push({ key: `d${s.label}`, label: `chg ${s.label}`, format: 'bp' });
    }
    const rows: Row[] = data.series.map((s, i) => {
      const row: Row = { tenor: s.label, now: now.values[i] };
      for (const snap of shown) {
        row[`y${snap.label}`] = snap.values[i];
        row[`d${snap.label}`] = bpDiff(now.values[i], snap.values[i]);
      }
      return row;
    });
    const missing = past.filter((s) => !shown.includes(s)).map((s) => s.label);
    return {
      blocks: [
        {
          kind: 'chart',
          title: `${name} government curve (${data.basis})`,
          xType: 'number',
          xLabel: 'Years to maturity',
          series: [{ name: latest, points: line(now.values) }, ...shown.map((s) => ({ name: `${s.label} ago (${s.date})`, points: line(s.values) }))],
          yFormat: 'pct',
          yDigits: 2,
        },
        { kind: 'table', columns, rows },
      ],
      source: data.source,
      sourceUrl: data.sourceUrl,
      asOf: latest,
      notes: [...data.notes, ...(missing.length ? [`No data near the ${missing.join(', ')} comparison date.`] : [])],
    };
  },
};

const curveChanges: CardDef = {
  id: 'rates.curve-changes',
  title: 'Curve Changes by Tenor',
  source: 'Official sources',
  description: 'Basis-point change at every tenor of the sovereign curve over one month to five years.',
  params: [countryParam(OECD_CODES)],
  async run(ctx, p) {
    const { data, latest, now, past } = await snapshots(ctx, p.country, [...HORIZONS]);
    const rows: Row[] = data.series.map((s, i) => {
      const row: Row = { tenor: s.label, now: now.values[i] };
      for (const snap of past) row[snap.label] = bpDiff(now.values[i], snap.values[i]);
      return row;
    });
    const first = now.values.findIndex((v) => v != null);
    const lastIdx = now.values.length - 1 - [...now.values].reverse().findIndex((v) => v != null);
    if (first >= 0 && lastIdx > first) {
      const spread = (v: (number | null)[]) => (v[lastIdx] == null || v[first] == null ? null : (v[lastIdx] as number) - (v[first] as number));
      const slope: Row = { tenor: `${data.series[lastIdx].label}-${data.series[first].label} slope`, now: spread(now.values) };
      for (const snap of past) slope[snap.label] = bpDiff(spread(now.values), spread(snap.values));
      rows.push(slope);
    }
    return {
      blocks: [
        {
          kind: 'table',
          title: `${countryBy(p.country)?.name ?? p.country}: change to ${latest}`,
          columns: [
            { key: 'tenor', label: 'Tenor' },
            { key: 'now', label: 'Yield', format: 'pct', digits: 2 },
            ...past.map((s): Column => ({ key: s.label, label: s.label, format: 'bp' })),
          ],
          rows,
          footnote: `Compared with: ${past.map((s) => `${s.label} ${s.date || 'n/a'}`).join(', ')}. The last row is the change in the slope between the shortest and longest tenor.`,
        },
      ],
      source: data.source,
      sourceUrl: data.sourceUrl,
      asOf: latest,
      notes: data.notes,
    };
  },
};

export const countryCards: CardDef[] = [globalYields, policyRates, curve, curveChanges, policyHistory, longRateHistory];
