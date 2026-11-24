/** Currencies > Rates & differentials, REER & reserves. */
import { pctChange } from '../../format.js';
import { fxPair, rangeStart } from '../../lib/market.js';
import { SourceError, type CardDef, type Row } from '../../types.js';
import { areaByCountry, areaByCurrency, AREAS, BIS, bisData, bisPoints } from './bis.js';
import { crossSeries, FX_NOTE, FX_SOURCE, fxPanel } from './fx-data.js';
import { IMF, imfData, imfPoints } from './imf.js';
import { correlation, DAY, mean, monthsBack, monthStartBack, rangeParam, since, toRange, valueAt, ymd, type Point } from './util.js';

const POLICY_URL = 'https://data.bis.org/topics/CBPOL';
/** Areas with a policy rate in the BIS dataset (Singapore targets the exchange rate and has none). */
const POLICY_AREAS = AREAS.filter((a) => a.code !== 'SG');

const policyRates: CardDef = {
  id: 'fx.policy-rates',
  title: 'Policy rates and differentials versus the U.S.',
  source: BIS,
  description: 'Central bank policy rates by country, the gap to the U.S. rate, and how each has moved over three months and a year.',
  async run(ctx) {
    const key = POLICY_AREAS.map((a) => a.code).join('+');
    const latest = await bisData(ctx, 'WS_CBPOL', `D.${key}`, 'lastNObservations=1', 3600);
    const monthly = await bisData(ctx, 'WS_CBPOL', `M.${key}`, `startPeriod=${monthStartBack(ctx.now(), 14).slice(0, 7)}`);
    const now = (code: string): Point | undefined => bisPoints(latest, { REF_AREA: code }).pop();
    const us = now('US');
    if (!us) throw new SourceError(BIS, 'no U.S. policy rate returned');
    const rows: Row[] = [];
    for (const a of POLICY_AREAS) {
      const p = now(a.code);
      if (!p) continue;
      const hist = bisPoints(monthly, { REF_AREA: a.code });
      const back = (months: number): number | null => {
        // Month-end value of the month `months` before the latest daily reading.
        const d = new Date(p[0]);
        return valueAt(hist, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1));
      };
      const m3 = back(3);
      const y1 = back(12);
      rows.push({
        name: a.name,
        currency: a.currency,
        rate: p[1],
        diff: (p[1] - us[1]) * 100,
        m3: m3 === null ? null : (p[1] - m3) * 100,
        y1: y1 === null ? null : (p[1] - y1) * 100,
        date: ymd(p[0]),
      });
    }
    rows.sort((x, y) => (y.rate as number) - (x.rate as number));
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Economy' },
            { key: 'currency', label: 'Ccy' },
            { key: 'rate', label: 'Policy rate', format: 'pct', digits: 2 },
            { key: 'diff', label: 'vs U.S.', format: 'bp' },
            { key: 'm3', label: '3M chg', format: 'bp' },
            { key: 'y1', label: '1Y chg', format: 'bp' },
            { key: 'date', label: 'As of', format: 'date' },
          ],
          rows,
        },
      ],
      sourceUrl: POLICY_URL,
      asOf: ymd(us[0]),
      notes: [
        'BIS central bank policy rates, daily, as reported by each central bank (the midpoint is used where the target is a range). Changes compare with the month-end rate three and twelve months earlier.',
      ],
    };
  },
};

const pairDifferential: CardDef = {
  id: 'fx.pair-differential',
  title: 'Currency pair against its policy-rate differential',
  source: `${FX_SOURCE}, ${BIS}`,
  description: 'Spot history for a currency pair beside the policy-rate differential between its two currencies.',
  params: [
    { name: 'symbol', label: 'Pair', default: 'EURUSD', hint: 'six letters, e.g. EURUSD, USDJPY, GBPUSD' },
    rangeParam('2Y', ['6M', '1Y', '2Y', '5Y', '10Y']),
  ],
  async run(ctx, params) {
    const pair = fxPair((params.symbol ?? 'EURUSD').replace(/[^A-Za-z=]/g, ''));
    if (!pair) throw new SourceError(FX_SOURCE, `not a currency pair: ${params.symbol}`);
    const a = areaByCurrency(pair.base);
    const b = areaByCurrency(pair.quote);
    if (!a || !b) throw new SourceError(BIS, `no policy rate mapped for ${!a ? pair.base : pair.quote}`);
    const range = toRange(params.range, '2Y');
    const from = rangeStart(range, ctx.now()).getTime();
    const panel = await fxPanel(ctx, ymd(from - 10 * DAY));
    const spot = since(crossSeries(panel, pair.base, pair.quote), from);
    if (!spot.length) throw new SourceError(FX_SOURCE, `no reference rates for ${pair.base}/${pair.quote}`);
    const rates = await bisData(ctx, 'WS_CBPOL', `M.${a.code}+${b.code}`, `startPeriod=${ymd(from).slice(0, 7)}`);
    const ra = bisPoints(rates, { REF_AREA: a.code });
    const rb = bisPoints(rates, { REF_AREA: b.code });
    const mb = new Map(rb);
    // Month-end policy rates are stamped at the first of the month; pair them with the last fixing of that month.
    const diff: Point[] = ra.filter(([t]) => mb.has(t)).map(([t, v]) => [t, v - (mb.get(t) as number)]);
    const monthEndSpot = (t: number): number | null => valueAt(spot, monthsBack(t, -1) - 1);
    const pairs = diff.map(([t, d]) => ({ d, s: monthEndSpot(t) })).filter((x): x is { d: number; s: number } => x.s !== null);
    const corr = correlation(pairs.map((x) => x.s), pairs.map((x) => x.d));
    const lastSpot = spot[spot.length - 1];
    const lastDiff = diff[diff.length - 1];
    const name = `${pair.base}${pair.quote}`;
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: `${name} spot`, value: lastSpot[1], format: 'num', digits: 4 },
            { label: `Spot change, ${range}`, value: pctChange(lastSpot[1], spot[0][1]), format: 'signedPct' },
            { label: `${a.name} policy rate`, value: ra[ra.length - 1]?.[1], format: 'pct', digits: 2 },
            { label: `${b.name} policy rate`, value: rb[rb.length - 1]?.[1], format: 'pct', digits: 2 },
            { label: `Differential (${pair.base} minus ${pair.quote})`, value: lastDiff ? lastDiff[1] * 100 : null, format: 'bp' },
            { label: `Differential change, ${range}`, value: lastDiff && diff.length > 1 ? (lastDiff[1] - diff[0][1]) * 100 : null, format: 'bp' },
            { label: 'Correlation, spot vs differential', value: corr, format: 'num', digits: 2 },
          ],
        },
        { kind: 'chart', title: `${name} spot`, xType: 'time', yFormat: 'num', yDigits: 4, series: [{ name, points: spot }] },
        {
          kind: 'chart',
          title: `Policy-rate differential, ${pair.base} minus ${pair.quote}, percentage points`,
          xType: 'time',
          yFormat: 'signed',
          yDigits: 2,
          series: [{ name: 'Differential', points: diff }],
        },
      ],
      sourceUrl: POLICY_URL,
      asOf: ymd(lastSpot[0]),
      notes: [
        'The differential uses month-end central bank policy rates (BIS), not 2-year yields: no open source here carries government 2-year yields for every currency. The correlation is between month-end spot and the differential over the range shown.',
        FX_NOTE,
      ],
    };
  },
};

const EER_URL = 'https://data.bis.org/topics/EER';

const reer: CardDef = {
  id: 'fx.reer',
  title: 'Real and nominal effective exchange rates',
  source: BIS,
  description: 'BIS broad effective exchange rate indices: history for one economy and a cross-country table of real-rate moves.',
  params: [
    { name: 'country', label: 'Country', default: 'US', hint: 'ISO-2, e.g. US, JP, GB, CN; EU for the euro area' },
    rangeParam('5Y', ['2Y', '5Y', '10Y']),
  ],
  async run(ctx, params) {
    const area = areaByCountry(params.country ?? 'US');
    if (!area) throw new SourceError(BIS, `unknown country: ${params.country} (use an ISO-2 code such as US, JP, DE is part of EU)`);
    const range = toRange(params.range, '5Y');
    const months = { '2Y': 25, '5Y': 61, '10Y': 121 }[range as '2Y'] ?? 61;
    const rows = await bisData(ctx, 'WS_EER', `M.R+N.B.${AREAS.map((a) => a.code).join('+')}`, `startPeriod=${monthStartBack(ctx.now(), Math.max(months, 61)).slice(0, 7)}`);
    const real = bisPoints(rows, { EER_TYPE: 'R', REF_AREA: area.code });
    const nominal = bisPoints(rows, { EER_TYPE: 'N', REF_AREA: area.code });
    if (!real.length) throw new SourceError(BIS, `no effective exchange rate for ${area.name}`);
    const from = monthsBack(real[real.length - 1][0], months - 1);
    const table: Row[] = [];
    for (const a of AREAS) {
      const r = bisPoints(rows, { EER_TYPE: 'R', REF_AREA: a.code });
      if (!r.length) continue;
      const [t, last] = r[r.length - 1];
      const avg5 = mean(since(r, monthsBack(t, 60)).map((p) => p[1]));
      table.push({
        name: a.name,
        last,
        m1: pctChange(last, valueAt(r, monthsBack(t, 1))),
        y1: pctChange(last, valueAt(r, monthsBack(t, 12))),
        vsAvg: avg5 ? ((last - avg5) / avg5) * 100 : null,
        month: ymd(t).slice(0, 7),
      });
    }
    table.sort((x, y) => ((y.y1 as number | null) ?? -Infinity) - ((x.y1 as number | null) ?? -Infinity));
    return {
      blocks: [
        {
          kind: 'chart',
          title: `${area.name}: effective exchange rate, broad basket (2020 = 100)`,
          xType: 'time',
          yFormat: 'num',
          yDigits: 1,
          series: [
            { name: 'Real', points: since(real, from) },
            { name: 'Nominal', points: since(nominal, from) },
          ],
        },
        {
          kind: 'table',
          title: 'Real effective exchange rate by economy',
          columns: [
            { key: 'name', label: 'Economy' },
            { key: 'last', label: 'REER', format: 'num', digits: 1 },
            { key: 'm1', label: '1M', format: 'signedPct', digits: 1 },
            { key: 'y1', label: '1Y', format: 'signedPct', digits: 1 },
            { key: 'vsAvg', label: 'vs 5Y avg', format: 'signedPct', digits: 1 },
            { key: 'month', label: 'Month' },
          ],
          rows: table,
        },
      ],
      sourceUrl: EER_URL,
      asOf: ymd(real[real.length - 1][0]).slice(0, 7),
      notes: ['BIS effective exchange rate indices, broad basket (64 economies), monthly averages. A rise is an appreciation; the real index adjusts the nominal one for relative consumer prices.'],
    };
  },
};

const reserves: CardDef = {
  id: 'fx.reserves',
  title: 'Official reserves by country',
  source: IMF,
  description: 'Official reserve assets by country: total including gold at market value, and excluding gold, with the change over a year.',
  async run(ctx) {
    const holders = AREAS.filter((a) => a.iso3);
    const rows = await imfData(ctx, 'IMF.STA,IL', `${holders.map((a) => a.iso3).join('+')}.TRGMV_REVS+RXF11_REVS.USD.M`, monthStartBack(ctx.now(), 20).slice(0, 7));
    const table: Row[] = [];
    let latest = 0;
    for (const a of holders) {
      const total = imfPoints(rows, { COUNTRY: a.iso3 as string, INDICATOR: 'TRGMV_REVS', FREQUENCY: 'M' });
      const exGold = imfPoints(rows, { COUNTRY: a.iso3 as string, INDICATOR: 'RXF11_REVS', FREQUENCY: 'M' });
      const main = total.length ? total : exGold;
      if (!main.length) continue;
      const [t, v] = main[main.length - 1];
      latest = Math.max(latest, t);
      const ex = valueAt(exGold, t);
      table.push({
        name: a.name,
        total: total.length ? v : null,
        exGold: ex,
        gold: total.length && ex !== null ? v - ex : null,
        y1: pctChange(v, valueAt(main, monthsBack(t, 12))),
        month: ymd(t).slice(0, 7),
      });
    }
    if (!table.length) throw new SourceError(IMF, 'no reserve data returned');
    table.sort((x, y) => ((y.total as number | null) ?? (y.exGold as number) ?? 0) - ((x.total as number | null) ?? (x.exGold as number) ?? 0));
    const top = table.slice(0, 12);
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Total reserves including gold, USD',
          xType: 'category',
          style: 'bar',
          categories: top.map((r) => String(r.name)),
          yFormat: 'usdCompact',
          series: [{ name: 'Reserves', points: top.map((r, i) => [i, (r.total as number | null) ?? (r.exGold as number) ?? 0] as [number, number]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Economy' },
            { key: 'total', label: 'Total incl. gold', format: 'usdCompact' },
            { key: 'exGold', label: 'Excl. gold', format: 'usdCompact' },
            { key: 'gold', label: 'Gold (market value)', format: 'usdCompact' },
            { key: 'y1', label: '1Y', format: 'signedPct', digits: 1 },
            { key: 'month', label: 'Month' },
          ],
          rows: table,
        },
      ],
      sourceUrl: 'https://data.imf.org/en/datasets/IMF.STA:IL',
      asOf: ymd(latest).slice(0, 7),
      notes: [
        'IMF International Liquidity: official reserve assets in U.S. dollars, gold valued at market prices. Countries report with different lags, so the month differs by row; the one-year change includes valuation effects. The euro area and Taiwan are not in this dataset.',
      ],
    };
  },
};

const COFER_CURRENCIES: [string, string][] = [
  ['CI_USD', 'U.S. dollar'],
  ['CI_EUR', 'Euro'],
  ['CI_JPY', 'Japanese yen'],
  ['CI_GBP', 'British pound'],
  ['CI_CAD', 'Canadian dollar'],
  ['CI_AUD', 'Australian dollar'],
  ['CI_CNY', 'Chinese renminbi'],
  ['CI_CHF', 'Swiss franc'],
  ['CI_OTHC', 'Other currencies'],
];

const cofer: CardDef = {
  id: 'fx.reserve-currencies',
  title: 'Currency composition of world reserves (COFER)',
  source: IMF,
  description: "Each currency's share of allocated official foreign exchange reserves worldwide, quarterly.",
  async run(ctx) {
    const start = `${ctx.now().getUTCFullYear() - 8}-Q1`;
    const rows = await imfData(ctx, 'IMF.STA,COFER', 'G001.AFXRA..SHRO_PT+NV_USD.Q', start);
    const table: Row[] = [];
    const lines: { name: string; points: Point[] }[] = [];
    let latest = 0;
    for (const [code, name] of COFER_CURRENCIES) {
      const share = imfPoints(rows, { FXR_CURRENCY: code, TYPE_OF_TRANSFORMATION: 'SHRO_PT' });
      const usd = imfPoints(rows, { FXR_CURRENCY: code, TYPE_OF_TRANSFORMATION: 'NV_USD' });
      if (!share.length) continue;
      const [t, v] = share[share.length - 1];
      latest = Math.max(latest, t);
      const y1 = valueAt(share, monthsBack(t, 12));
      const y5 = valueAt(share, monthsBack(t, 60));
      table.push({ name, share: v, y1: y1 === null ? null : v - y1, y5: y5 === null ? null : v - y5, usd: usd[usd.length - 1]?.[1] });
      if (lines.length < 5) lines.push({ name, points: share });
    }
    if (!table.length) throw new SourceError(IMF, 'no COFER data returned');
    const total = imfPoints(rows, { FXR_CURRENCY: 'CI_T', TYPE_OF_TRANSFORMATION: 'NV_USD' });
    const q = new Date(latest);
    const label = `${q.getUTCFullYear()}-Q${Math.floor(q.getUTCMonth() / 3) + 1}`;
    return {
      blocks: [
        { kind: 'chart', title: 'Share of allocated reserves, percent', xType: 'time', yFormat: 'pct', yDigits: 0, series: lines },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Currency' },
            { key: 'share', label: 'Share', format: 'pct', digits: 2 },
            { key: 'y1', label: '1Y chg (pp)', format: 'signed', digits: 2 },
            { key: 'y5', label: '5Y chg (pp)', format: 'signed', digits: 2 },
            { key: 'usd', label: 'Holdings', format: 'usdCompact' },
          ],
          rows: table,
          footnote: total.length ? `Allocated reserves in total: $${(total[total.length - 1][1] / 1e12).toFixed(2)} trillion.` : undefined,
        },
      ],
      sourceUrl: 'https://data.imf.org/en/datasets/IMF.STA:COFER',
      asOf: label,
      notes: ['IMF COFER: world totals reported confidentially by reserve holders, published quarterly with a lag of about three months. Shares move with exchange rates as well as with purchases and sales.'],
    };
  },
};

export const fxRatesCards: CardDef[] = [policyRates, pairDifferential];
export const fxReserveCards: CardDef[] = [reer, reserves, cofer];
