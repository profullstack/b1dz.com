/** Commodities > Boards and Curves; Agriculture > Boards. Official and reachable sources first. */
import { SourceError, type Block, type CardDef, type Row } from '../../types.js';
import { EIA, eiaNotes, eiaPoints } from './eia.js';
import { crudeFutures, GAS, gasPrices, petroleumSpot, SPOT, WTI_CONTRACTS } from './energy-data.js';
import { curveCard, futuresBoardCard } from './futures.js';
import { IMF, PCPS, PCPS_URL, pcpsSeries } from './imf.js';
import { monthStartBack, pointReturns, rangeParam, RETURN_COLUMNS_DAILY, RETURN_COLUMNS_MONTHLY, toRange, ymd, type Point } from './util.js';

const energyBoard: CardDef = {
  id: 'commodities.energy-board',
  title: 'Energy spot prices',
  source: EIA,
  description: 'Daily spot prices for crude oil, refined products and natural gas, with returns.',
  async run(ctx) {
    const [oil, gas] = await Promise.all([petroleumSpot(ctx), gasPrices(ctx)]);
    const rows: Row[] = [];
    let asOf = 0;
    const add = (name: string, unit: string, pts: Point[]): void => {
      if (!pts.length) return;
      const r = pointReturns(pts);
      asOf = Math.max(asOf, r.asOf ?? 0);
      rows.push({ name, unit, ...r, date: r.asOf ? ymd(r.asOf) : null });
    };
    for (const s of Object.values(SPOT)) add(s.name, s.unit, eiaPoints(oil, 'series', s.id));
    add(GAS.spot.name, GAS.spot.unit, eiaPoints(gas, 'series', GAS.spot.id));
    if (!rows.length) throw new SourceError(EIA, 'no spot prices returned');
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Price', maxWidth: 32 },
            { key: 'unit', label: 'Unit' },
            { key: 'last', label: 'Last', format: 'num', digits: 2 },
            ...RETURN_COLUMNS_DAILY,
            { key: 'date', label: 'Date', format: 'date' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://www.eia.gov/dnav/pet/pet_pri_spt_s1_d.htm',
      asOf: ymd(asOf),
      notes: ['Daily spot assessments published by the EIA with a lag of several days; not futures and not live quotes.', ...eiaNotes(ctx)],
    };
  },
};

/** A board of IMF monthly benchmark prices in one or more groups. */
function pcpsBoard(def: { id: string; title: string; description: string; groups: { title: string; codes: string[] }[] }): CardDef {
  return {
    id: def.id,
    title: def.title,
    source: IMF,
    description: def.description,
    async run(ctx) {
      const codes = def.groups.flatMap((g) => g.codes);
      const got = await pcpsSeries(ctx, codes, monthStartBack(ctx.now(), 15).slice(0, 7));
      let asOf = 0;
      const blocks: Block[] = def.groups.map((g) => ({
        kind: 'table',
        title: g.title,
        columns: [
          { key: 'name', label: 'Commodity', maxWidth: 28 },
          { key: 'unit', label: 'Unit' },
          { key: 'last', label: 'Month avg', format: 'num', digits: 2 },
          ...RETURN_COLUMNS_MONTHLY,
        ],
        rows: g.codes
          .filter((c) => got.has(c))
          .map((c) => {
            const r = pointReturns(got.get(c) as Point[]);
            asOf = Math.max(asOf, r.asOf ?? 0);
            return { name: PCPS[c].name, unit: PCPS[c].unit, ...r };
          }),
      }));
      return {
        blocks,
        sourceUrl: PCPS_URL,
        asOf: ymd(asOf).slice(0, 7),
        notes: ['Monthly average benchmark prices from the IMF Primary Commodity Price System, updated about two weeks after month end. Changes compare monthly averages; YTD is measured from the previous December.'],
      };
    },
  };
}

const metalsBoard = pcpsBoard({
  id: 'commodities.metals-board',
  title: 'Metals prices',
  description: 'Monthly benchmark prices for precious and base metals, with returns.',
  groups: [
    { title: 'Precious metals', codes: ['PGOLD', 'PSILVER', 'PPLAT', 'PPALLA'] },
    { title: 'Base metals and bulks', codes: ['PCOPP', 'PALUM', 'PNICK', 'PZINC', 'PLEAD', 'PTIN', 'PCOBA', 'PIORECR'] },
  ],
});

const energyMonthly = pcpsBoard({
  id: 'commodities.energy-benchmarks',
  title: 'Energy benchmarks worldwide',
  description: 'Monthly benchmark prices for crude grades, regional natural gas, coal and uranium.',
  groups: [
    { title: 'Crude oil', codes: ['POILBRE', 'POILWTI', 'POILDUB'] },
    { title: 'Natural gas and LNG', codes: ['PNGASUS', 'PNGASEU', 'PNGASJP', 'PPROPANE'] },
    { title: 'Coal and uranium', codes: ['PCOALAU', 'PCOALSA', 'PURAN'] },
  ],
});

export const agriBoard = pcpsBoard({
  id: 'agri.board',
  title: 'Agricultural prices',
  description: 'Monthly benchmark prices for grains and oilseeds, softs, livestock and fertilizers, with returns.',
  groups: [
    { title: 'Grains and oilseeds', codes: ['PMAIZMT', 'PWHEAMT', 'PSOYB', 'PRICENPQ', 'PBARL', 'PSMEA', 'PSOIL', 'PPOIL', 'PSUNO'] },
    { title: 'Softs', codes: ['PSUGAISA', 'PSUGAUSA', 'PCOFFOTM', 'PCOFFROB', 'PCOCO', 'PCOTTIND', 'PORANG', 'PRUBB'] },
    { title: 'Livestock', codes: ['PBEEF', 'PPORK', 'PPOULT', 'PLAMB'] },
    { title: 'Fertilizers', codes: ['PUREA', 'PDAP', 'PPOTASH'] },
  ],
});

function historyCard(def: { id: string; title: string; description: string; codes: string[]; fallback: string }): CardDef {
  return {
    id: def.id,
    title: def.title,
    source: IMF,
    description: def.description,
    params: [
      { name: 'series', label: 'Commodity', default: def.fallback, choices: def.codes, hint: def.codes.map((c) => `${c} ${PCPS[c].name}`).join(', ') },
      rangeParam('5Y', ['1Y', '2Y', '5Y', '10Y', 'MAX']),
    ],
    async run(ctx, params) {
      const code = (params.series ?? '').trim().toUpperCase();
      const item = PCPS[code] ?? PCPS[def.fallback];
      const range = toRange(params.range, '5Y');
      const months = { '1Y': 13, '2Y': 25, '5Y': 61, '10Y': 121, MAX: 12 * 40 }[range as '1Y'] ?? 61;
      const pts = (await pcpsSeries(ctx, [item.code], monthStartBack(ctx.now(), months).slice(0, 7))).get(item.code) as Point[];
      const r = pointReturns(pts);
      const values = pts.map((p) => p[1]);
      return {
        blocks: [
          {
            kind: 'stats',
            items: [
              { label: `${item.name} (${item.unit})`, value: r.last, format: 'num', digits: 2 },
              { label: '1M', value: r.prev, format: 'signedPct' },
              { label: '1Y', value: r.y1, format: 'signedPct' },
              { label: `Low, ${range}`, value: Math.min(...values), format: 'num', digits: 2 },
              { label: `High, ${range}`, value: Math.max(...values), format: 'num', digits: 2 },
            ],
          },
          { kind: 'chart', title: `${item.name}, ${item.unit} (monthly average)`, xType: 'time', yFormat: 'num', yDigits: 2, series: [{ name: item.name, points: pts }] },
        ],
        sourceUrl: PCPS_URL,
        asOf: r.asOf ? ymd(r.asOf).slice(0, 7) : undefined,
        notes: ['Monthly averages from the IMF Primary Commodity Price System.'],
      };
    },
  };
}

const commodityHistory = historyCard({
  id: 'commodities.price-history',
  title: 'Commodity price history',
  description: 'Monthly price history for one energy or metals benchmark.',
  codes: ['PGOLD', 'PSILVER', 'PPLAT', 'PPALLA', 'PCOPP', 'PALUM', 'PNICK', 'PZINC', 'PLEAD', 'PTIN', 'PIORECR', 'PCOBA', 'POILBRE', 'POILWTI', 'POILDUB', 'PNGASUS', 'PNGASEU', 'PNGASJP', 'PCOALAU', 'PURAN'],
  fallback: 'PGOLD',
});

export const agriHistory = historyCard({
  id: 'agri.price-history',
  title: 'Agricultural price history',
  description: 'Monthly price history for one grain, soft, livestock or fertilizer benchmark.',
  codes: ['PMAIZMT', 'PWHEAMT', 'PSOYB', 'PRICENPQ', 'PSMEA', 'PSOIL', 'PPOIL', 'PSUGAISA', 'PCOFFOTM', 'PCOFFROB', 'PCOCO', 'PCOTTIND', 'PORANG', 'PBEEF', 'PPORK', 'PPOULT', 'PUREA', 'PDAP', 'PPOTASH'],
  fallback: 'PMAIZMT',
});

const futuresBoard = futuresBoardCard({
  id: 'commodities.futures-board',
  title: 'Commodity futures board',
  description: 'Front-month energy and metals futures with returns over five horizons.',
  symbols: [
    { symbol: 'CL=F', label: 'WTI crude oil' },
    { symbol: 'BZ=F', label: 'Brent crude oil' },
    { symbol: 'NG=F', label: 'Natural gas' },
    { symbol: 'RB=F', label: 'RBOB gasoline' },
    { symbol: 'HO=F', label: 'Heating oil' },
    { symbol: 'GC=F', label: 'Gold' },
    { symbol: 'SI=F', label: 'Silver' },
    { symbol: 'HG=F', label: 'Copper' },
    { symbol: 'PL=F', label: 'Platinum' },
    { symbol: 'PA=F', label: 'Palladium' },
  ],
});

export const agriFuturesBoard = futuresBoardCard({
  id: 'agri.futures-board',
  title: 'Agricultural futures board',
  description: 'Front-month grain, soft and livestock futures with returns over five horizons.',
  symbols: [
    { symbol: 'ZC=F', label: 'Corn' },
    { symbol: 'ZW=F', label: 'Wheat (Chicago)' },
    { symbol: 'KE=F', label: 'Wheat (Kansas City)' },
    { symbol: 'ZS=F', label: 'Soybeans' },
    { symbol: 'ZM=F', label: 'Soybean meal' },
    { symbol: 'ZL=F', label: 'Soybean oil' },
    { symbol: 'SB=F', label: 'Sugar No. 11' },
    { symbol: 'KC=F', label: 'Coffee C' },
    { symbol: 'CC=F', label: 'Cocoa' },
    { symbol: 'CT=F', label: 'Cotton No. 2' },
    { symbol: 'OJ=F', label: 'Orange juice' },
    { symbol: 'LE=F', label: 'Live cattle' },
    { symbol: 'GF=F', label: 'Feeder cattle' },
    { symbol: 'HE=F', label: 'Lean hogs' },
  ],
});

const futuresCurve = curveCard({
  id: 'commodities.futures-curve',
  title: 'Forward curves: crude, gas, gold, copper',
  description: 'The forward curve from dated futures contracts for WTI, natural gas, gold or copper.',
  roots: ['CL', 'NG', 'GC', 'HG'],
  count: 12,
});

export const agriFuturesCurve = curveCard({
  id: 'agri.futures-curve',
  title: 'Forward curves: corn, wheat, soybeans',
  description: 'The forward curve from dated futures contracts for corn, wheat or soybeans.',
  roots: ['ZC', 'ZW', 'ZS'],
  count: 8,
});

const wtiCurve: CardDef = {
  id: 'commodities.wti-nearby-curve',
  title: 'WTI futures: the four nearest contracts',
  source: EIA,
  description: 'Settlement prices of the four nearest NYMEX WTI contracts as published by the EIA: the front of the forward curve.',
  async run(ctx) {
    const rows = await crudeFutures(ctx);
    const series = WTI_CONTRACTS.map((id, i) => ({ n: i + 1, pts: eiaPoints(rows, 'series', id) })).filter((s) => s.pts.length);
    if (series.length < 2) throw new SourceError(EIA, 'the EIA returned no NYMEX contract prices');
    const end = Math.max(...series.map((s) => s.pts[s.pts.length - 1][0]));
    const curve = series.flatMap((s) => {
      const last = s.pts[s.pts.length - 1];
      return last[0] === end ? [{ n: s.n, price: last[1], prev: s.pts.length > 1 ? s.pts[s.pts.length - 2][1] : null }] : [];
    });
    if (curve.length < 2) throw new SourceError(EIA, 'contract prices are not available for one common date');
    const front = curve[0].price;
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'NYMEX WTI, USD per barrel, by contract month',
          xType: 'number',
          xLabel: 'Contract (1 = front month)',
          yFormat: 'num',
          yDigits: 2,
          series: [{ name: ymd(end), points: curve.map((c) => [c.n, c.price] as [number, number]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Contract' },
            { key: 'price', label: 'Settle', format: 'num', digits: 2 },
            { key: 'day', label: 'Day', format: 'signed', digits: 2 },
            { key: 'vsFront', label: 'vs front', format: 'signed', digits: 2 },
          ],
          rows: curve.map((c) => ({ name: `Contract ${c.n}`, price: c.price, day: c.prev === null ? null : c.price - c.prev, vsFront: c.price - front })),
          footnote: curve[curve.length - 1].price < front ? 'Backwardation: later months are cheaper than the front.' : 'Contango: later months are dearer than the front.',
        },
      ],
      sourceUrl: 'https://www.eia.gov/dnav/pet/pet_pri_fut_s1_d.htm',
      asOf: ymd(end),
      notes: ['NYMEX settlement prices republished by the EIA, several days in arrears; only the four nearest contracts are published.', ...eiaNotes(ctx)],
    };
  },
};

export const commodityBoardCards: CardDef[] = [metalsBoard, energyMonthly, commodityHistory, energyBoard, futuresBoard];
export const commodityCurveCards: CardDef[] = [wtiCurve, futuresCurve];
