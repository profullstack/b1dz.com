/** Economy by Country: a cross-country monitor, OECD snapshot, external accounts and IMF forecasts. */
import { isoDate } from '../../format.js';
import { SourceError, type CardDef, type DashboardDef, type ParamSpec, type Row } from '../../types.js';
import { MONITOR, nameOf, resolveEconomy } from './countries.js';
import { bisData, byArea, imfIndicator, imfPoints, oecdData, RANGE_CHOICES, rangeStartMs, type ImfTable, type SdmxObs } from './data.js';

const COUNTRY: ParamSpec = { name: 'country', label: 'Country', default: 'US', hint: 'ISO-2 code, e.g. US, DE, JP, or XM for the euro area' };

const IMF_URL = 'https://www.imf.org/external/datamapper/datasets/WEO';
const WEO_NOTE = 'IMF World Economic Outlook, annual. The current and later years are IMF projections.';

/** Value for `year`, else the nearest earlier year that has one (within three years). */
export function imfValue(table: ImfTable, code: string, year: number): { value: number; year: number } | null {
  const row = table[code];
  if (!row) return null;
  for (let y = year; y >= year - 3; y--) {
    const v = row[String(y)];
    if (typeof v === 'number') return { value: v, year: y };
  }
  return null;
}

function latestByArea(obs: SdmxObs[]): Map<string, SdmxObs> {
  const out = new Map<string, SdmxObs>();
  for (const [area, list] of byArea(obs)) out.set(area, list[list.length - 1]);
  return out;
}

const monitor: CardDef = {
  id: 'macro.country-monitor',
  title: 'Country Monitor',
  source: 'IMF, BIS, OECD',
  description: 'Growth, inflation, unemployment, policy rate and 10-year yield for 17 major economies.',
  async run(ctx) {
    const year = ctx.now().getUTCFullYear();
    const bisAreas = [...new Set(MONITOR.map((m) => m.bis))].join('+');
    const oecdAreas = MONITOR.map((m) => m.oecd).join('+');
    const [gdp, cpi, lur, rates, yields] = await Promise.all([
      imfIndicator(ctx, 'NGDP_RPCH'),
      imfIndicator(ctx, 'PCPIPCH'),
      imfIndicator(ctx, 'LUR'),
      bisData(ctx, 'WS_CBPOL', `D.${bisAreas}`, 'lastNObservations=1'),
      oecdData(ctx, 'OECD.SDD.STES,DSD_STES@DF_FINMARK,4.0', `${oecdAreas}.M.IRLT.PA._Z._Z._Z._Z.N`, 'lastNObservations=1'),
    ]);
    const rate = latestByArea(rates);
    const yld = latestByArea(yields);
    const rows: Row[] = MONITOR.map((m) => {
      const r = rate.get(m.bis);
      const y = yld.get(m.oecd);
      return {
        country: m.name,
        code: m.iso2,
        gdp: imfValue(gdp, m.imf, year)?.value ?? null,
        cpi: imfValue(cpi, m.imf, year)?.value ?? null,
        unemp: imfValue(lur, m.imf, year)?.value ?? null,
        policy: r?.value ?? null,
        policyDate: r?.period ?? null,
        y10: y?.value ?? null,
        y10Month: y?.period ?? null,
      };
    });
    const asOf = [...rate.values()].map((o) => o.period).sort().pop();
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'country', label: 'Economy' },
            { key: 'code', label: 'Code' },
            { key: 'gdp', label: `GDP growth ${year}`, format: 'signedPct', digits: 1 },
            { key: 'cpi', label: `Inflation ${year}`, format: 'pct', digits: 1 },
            { key: 'unemp', label: `Unemployment ${year}`, format: 'pct', digits: 1 },
            { key: 'policy', label: 'Policy rate', format: 'pct', digits: 2 },
            { key: 'policyDate', label: 'Rate as of' },
            { key: 'y10', label: '10Y yield', format: 'pct', digits: 2 },
            { key: 'y10Month', label: 'Yield month' },
          ],
          rows,
          footnote: 'Euro-area members share the ECB policy rate. Pass a Code as the country to the cards below.',
        },
      ],
      sourceUrl: IMF_URL,
      asOf,
      notes: [
        `Growth, inflation and unemployment: ${WEO_NOTE}`,
        'Policy rate: BIS central bank policy rates, daily. 10-year yield: OECD long-term interest rates, monthly average.',
      ],
    };
  },
};

const inflation: CardDef = {
  id: 'macro.country-inflation',
  title: 'Consumer Price Inflation',
  source: 'IMF',
  description: 'Annual average consumer price inflation for one country since 1980, with IMF projections.',
  params: [COUNTRY],
  async run(ctx, p) {
    const eco = resolveEconomy(p.country);
    const year = ctx.now().getUTCFullYear();
    const table = await imfIndicator(ctx, 'PCPIPCH');
    const points = imfPoints(table, eco.imf, 1980);
    if (!points.length) throw new SourceError('IMF', `no inflation series for ${eco.name} (${eco.imf})`);
    const rows: Row[] = points
      .filter(([t]) => new Date(t).getUTCFullYear() >= year - 10)
      .map(([t, v]) => {
        const y = new Date(t).getUTCFullYear();
        return { year: String(y), value: v, kind: y >= year ? 'projection' : 'actual' };
      })
      .reverse();
    return {
      blocks: [
        { kind: 'chart', title: `${eco.name}: consumer prices, annual % change`, xType: 'time', series: [{ name: 'Inflation', points }], yFormat: 'pct', yDigits: 1 },
        { kind: 'table', columns: [{ key: 'year', label: 'Year' }, { key: 'value', label: 'Inflation', format: 'pct', digits: 1 }, { key: 'kind', label: '' }], rows },
      ],
      sourceUrl: 'https://www.imf.org/external/datamapper/PCPIPCH@WEO',
      asOf: String(year),
      notes: [WEO_NOTE, 'Period average consumer prices.'],
    };
  },
};

const policyRate: CardDef = {
  id: 'macro.country-policy-rate',
  title: 'Central Bank Policy Rate',
  source: 'BIS',
  description: 'Policy rate history for one country from the BIS policy-rate database.',
  params: [COUNTRY, { name: 'range', label: 'Range', default: '10Y', choices: RANGE_CHOICES }],
  async run(ctx, p) {
    const eco = resolveEconomy(p.country);
    const start = new Date(rangeStartMs(p.range, ctx.now(), '10Y'));
    const startPeriod = `${Math.max(start.getUTCFullYear(), 1946)}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    const [monthly, daily] = await Promise.all([
      bisData(ctx, 'WS_CBPOL', `M.${eco.bis}`, `startPeriod=${startPeriod}`, 21600),
      bisData(ctx, 'WS_CBPOL', `D.${eco.bis}`, 'lastNObservations=1'),
    ]);
    if (!monthly.length) throw new SourceError('BIS', `no policy rate for ${eco.name} (${eco.bis})`);
    const points = monthly.map((o) => [o.t, o.value] as [number, number]);
    const last = daily[daily.length - 1] ?? monthly[monthly.length - 1];
    const yearAgo = monthly.length > 12 ? monthly[monthly.length - 13] : undefined;
    const changes = monthly.filter((o, i) => i > 0 && o.value !== monthly[i - 1].value);
    const lastChange = changes[changes.length - 1];
    const prev = lastChange ? monthly[monthly.indexOf(lastChange) - 1] : undefined;
    const bank = last.dims.SOURCE_REF || monthly[monthly.length - 1].dims.SOURCE_REF || '';
    const notes = ['Monthly end-of-period values on the chart; the latest reading is daily.'];
    if (eco.bis === 'XM' && eco.iso2 !== 'XM') notes.push(`${eco.name} is in the euro area: this is the ECB rate.`);
    const definition = last.dims.COMPILATION;
    if (definition) notes.push(definition);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Central bank', value: bank },
            { label: 'Policy rate', value: last.value, format: 'pct', digits: 2 },
            { label: 'As of', value: last.period },
            { label: 'Change over 12 months', value: yearAgo ? (last.value - yearAgo.value) * 100 : null, format: 'bp' },
            { label: 'Last change (month)', value: lastChange?.period ?? 'none in range' },
            { label: 'Size of last change', value: lastChange && prev ? (lastChange.value - prev.value) * 100 : null, format: 'bp' },
          ],
        },
        { kind: 'chart', title: `${eco.bis === 'XM' ? 'Euro area' : eco.name}: policy rate`, xType: 'time', series: [{ name: 'Policy rate', points }], yFormat: 'pct', yDigits: 2 },
      ],
      sourceUrl: 'https://data.bis.org/topics/CBPOL',
      asOf: last.period,
      notes,
    };
  },
};

const OECD_STALE_MS = 200 * 86_400_000;

const oecdSnapshot: CardDef = {
  id: 'macro.oecd-snapshot',
  title: 'OECD Snapshot',
  source: 'OECD',
  description: 'Composite leading indicator, unemployment rate and consumer price inflation for OECD members and partners.',
  async run(ctx) {
    const [cli, une, cpi, hicp] = await Promise.all([
      oecdData(ctx, 'OECD.SDD.STES,DSD_STES@DF_CLI,4.1', '.M.LI...AA...H', 'lastNObservations=7'),
      oecdData(ctx, 'OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M,1.0', '.UNE_LF_M.PT_LF_SUB._Z.Y._T.Y_GE15..M', 'lastNObservations=13'),
      oecdData(ctx, 'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0', '.M.N.CPI.PA._T.N.GY', 'lastNObservations=2'),
      oecdData(ctx, 'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0', '.M.HICP.CPI.PA._T.N.GY', 'lastNObservations=2').catch(() => [] as SdmxObs[]),
    ]);
    const now = ctx.now().getTime();
    const fresh = (list: SdmxObs[] | undefined): SdmxObs[] => (list && list.length && now - list[list.length - 1].t < OECD_STALE_MS ? list : []);
    const cliBy = byArea(cli);
    const uneBy = byArea(une);
    const cpiBy = byArea(cpi);
    const hicpBy = byArea(hicp);
    const areas = new Set([...uneBy.keys(), ...cpiBy.keys(), ...hicpBy.keys(), ...cliBy.keys()]);
    // The datasets name the same aggregate differently (EA / EA20), so rows are merged on the display name.
    const merged = new Map<string, Row>();
    for (const area of areas) {
      const c = fresh(cliBy.get(area));
      const u = fresh(uneBy.get(area));
      const national = fresh(cpiBy.get(area));
      const i = national.length ? national : fresh(hicpBy.get(area));
      if (!c.length && !u.length && !i.length) continue;
      const cLast = c[c.length - 1];
      const uLast = u[u.length - 1];
      const found: Row = {
        cli: cLast?.value ?? null,
        cli6: c.length >= 7 ? cLast.value - c[0].value : null,
        cliMonth: cLast?.period ?? null,
        unemp: uLast?.value ?? null,
        unemp12: u.length >= 13 ? uLast.value - u[0].value : null,
        unempMonth: uLast?.period ?? null,
        cpi: i[i.length - 1]?.value ?? null,
        cpiMonth: i[i.length - 1]?.period ?? null,
      };
      const name = nameOf(area);
      const row = merged.get(name) ?? { country: name };
      for (const [k, v] of Object.entries(found)) if (v !== null && (row[k] === undefined || row[k] === null)) row[k] = v;
      merged.set(name, row);
    }
    const rows = [...merged.values()];
    if (!rows.length) throw new SourceError('OECD', 'no current observations');
    rows.sort((a, b) => String(a.country).localeCompare(String(b.country)));
    const asOf = rows.map((r) => String(r.cpiMonth ?? r.unempMonth ?? '')).sort().pop();
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'country', label: 'Economy' },
            { key: 'cli', label: 'Leading index', format: 'num', digits: 2 },
            { key: 'cli6', label: '6M chg', format: 'signed', digits: 2 },
            { key: 'cliMonth', label: 'Month' },
            { key: 'unemp', label: 'Unemployment', format: 'pct', digits: 1 },
            { key: 'unemp12', label: '12M chg (pp)', format: 'signed', digits: 1 },
            { key: 'unempMonth', label: 'Month' },
            { key: 'cpi', label: 'CPI y/y', format: 'pct', digits: 1 },
            { key: 'cpiMonth', label: 'Month' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://data-explorer.oecd.org/',
      asOf,
      notes: [
        'Leading index: OECD composite leading indicator, amplitude adjusted (100 = long-term trend); above 100 and rising signals expansion.',
        'Unemployment: harmonised monthly rate, seasonally adjusted, ages 15 and over. CPI: all items, change on a year earlier (the EU harmonised index where the national index is not current).',
        'A figure whose latest observation is more than about six months old is left blank.',
      ],
    };
  },
};

const externalAccounts: CardDef = {
  id: 'macro.external-accounts',
  title: 'External and Fiscal Balances',
  source: 'IMF',
  description: 'Current account balance, government gross debt and net lending/borrowing as a share of GDP.',
  async run(ctx) {
    const year = ctx.now().getUTCFullYear();
    const [bca, debt, deficit] = await Promise.all([imfIndicator(ctx, 'BCA_NGDPD'), imfIndicator(ctx, 'GGXWDG_NGDP'), imfIndicator(ctx, 'GGXCNL_NGDP')]);
    const rows: Row[] = MONITOR.map((m) => ({
      country: m.name,
      bca: imfValue(bca, m.imf, year)?.value ?? null,
      bcaPrev: imfValue(bca, m.imf, year - 1)?.value ?? null,
      debt: imfValue(debt, m.imf, year)?.value ?? null,
      debt5: (() => {
        const a = imfValue(debt, m.imf, year);
        const b = debt[m.imf]?.[String(year - 5)];
        return a && typeof b === 'number' ? a.value - b : null;
      })(),
      deficit: imfValue(deficit, m.imf, year)?.value ?? null,
    }));
    const charted = rows.filter((r) => typeof r.bca === 'number');
    return {
      blocks: [
        {
          kind: 'chart',
          title: `Current account balance, % of GDP (${year})`,
          xType: 'category',
          style: 'bar',
          categories: charted.map((r) => String(r.country)),
          series: [{ name: 'Current account', points: charted.map((r, i) => [i, r.bca as number]) }],
          yFormat: 'signedPct',
          yDigits: 1,
        },
        {
          kind: 'table',
          columns: [
            { key: 'country', label: 'Economy' },
            { key: 'bca', label: `Current account ${year}`, format: 'signedPct', digits: 1 },
            { key: 'bcaPrev', label: `${year - 1}`, format: 'signedPct', digits: 1 },
            { key: 'debt', label: `Gov. gross debt ${year}`, format: 'pct', digits: 1 },
            { key: 'debt5', label: '5Y chg (pp)', format: 'signed', digits: 1 },
            { key: 'deficit', label: `Fiscal balance ${year}`, format: 'signedPct', digits: 1 },
          ],
          rows,
          footnote: 'All columns are percent of GDP. Fiscal balance is general government net lending (+) or borrowing (-).',
        },
      ],
      sourceUrl: IMF_URL,
      asOf: String(year),
      notes: [WEO_NOTE],
    };
  },
};

const FORECAST_SERIES: { code: string; key: string; label: string; format: 'pct' | 'signedPct' }[] = [
  { code: 'NGDP_RPCH', key: 'gdp', label: 'GDP growth', format: 'signedPct' },
  { code: 'PCPIPCH', key: 'cpi', label: 'Inflation', format: 'pct' },
  { code: 'LUR', key: 'unemp', label: 'Unemployment', format: 'pct' },
  { code: 'BCA_NGDPD', key: 'bca', label: 'Current account % GDP', format: 'signedPct' },
  { code: 'GGXWDG_NGDP', key: 'debt', label: 'Gov. debt % GDP', format: 'pct' },
];

const forecasts: CardDef = {
  id: 'macro.imf-forecasts',
  title: 'IMF Forecasts',
  source: 'IMF',
  description: 'World Economic Outlook figures for one country: the last five years and the next five.',
  params: [COUNTRY],
  async run(ctx, p) {
    const eco = resolveEconomy(p.country);
    const year = ctx.now().getUTCFullYear();
    const tables = await Promise.all(FORECAST_SERIES.map((s) => imfIndicator(ctx, s.code)));
    const rows: Row[] = [];
    for (let y = year - 5; y <= year + 5; y++) {
      const row: Row = { year: String(y), kind: y >= year ? 'projection' : 'actual' };
      let any = false;
      FORECAST_SERIES.forEach((s, i) => {
        const v = tables[i][eco.imf]?.[String(y)];
        row[s.key] = typeof v === 'number' ? v : null;
        if (typeof v === 'number') any = true;
      });
      if (any) rows.push(row);
    }
    if (!rows.length) throw new SourceError('IMF', `no World Economic Outlook data for ${eco.name} (${eco.imf})`);
    return {
      blocks: [
        {
          kind: 'chart',
          title: `${eco.name}: growth and inflation, %`,
          xType: 'time',
          series: [
            { name: 'GDP growth', points: imfPoints(tables[0], eco.imf, year - 5, year + 5) },
            { name: 'Inflation', points: imfPoints(tables[1], eco.imf, year - 5, year + 5) },
          ],
          yFormat: 'pct',
          yDigits: 1,
        },
        {
          kind: 'table',
          columns: [
            { key: 'year', label: 'Year' },
            ...FORECAST_SERIES.map((s) => ({ key: s.key, label: s.label, format: s.format, digits: 1 })),
            { key: 'kind', label: '' },
          ],
          rows,
        },
      ],
      sourceUrl: IMF_URL,
      asOf: isoDate(ctx.now()).slice(0, 4),
      notes: [WEO_NOTE],
    };
  },
};

export const economyCards: CardDef[] = [monitor, inflation, policyRate, oecdSnapshot, externalAccounts, forecasts];

export function economyDashboard(newsCard: string): DashboardDef {
  return {
    id: 'economy',
    title: 'Economy by Country',
    group: 'Macro & Economy',
    tabs: [
      { id: 'monitor', title: 'Country Monitor', cards: ['macro.country-monitor', 'macro.country-inflation', 'macro.country-policy-rate', newsCard] },
      { id: 'oecd', title: 'OECD snapshot', cards: ['macro.oecd-snapshot'] },
      { id: 'external', title: 'External accounts', cards: ['macro.external-accounts'] },
      { id: 'forecasts', title: 'IMF forecasts', cards: ['macro.imf-forecasts'] },
    ],
  };
}
