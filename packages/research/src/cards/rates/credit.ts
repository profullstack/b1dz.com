/** Credit dashboard: spreads, CDS indices, bond pricer, debt maturity wall, private credit, lending. */
import { num } from '../../http.js';
import { returnsBoard } from '../../lib/market.js';
import { SourceError, type Block, type CardDef, type Ctx, type Row } from '../../types.js';
import { fred, fredLines } from './fredx.js';
import { resolveMaturity, valueAtYield, yearsBetween, yieldFromPrice, type Bond } from './bondmath.js';
import { tableToSeries, treasuryTable, yearsFor } from './curves.js';
import { SDR_URL, sdrTrades, type SdrTrade } from './rates-swaps-policy.js';
import { DAY, curveAt, dayMs, interpolate, latestDate, median, percentileRank, shiftBack, ymd } from './util.js';

// ---------- ICE BofA option-adjusted spreads (FRED) ----------

interface SpreadSeries {
  id: string;
  name: string;
}

const RATING_TIERS: SpreadSeries[] = [
  { id: 'BAMLC0A0CM', name: 'U.S. investment grade' },
  { id: 'BAMLC0A1CAAA', name: '  AAA' },
  { id: 'BAMLC0A2CAA', name: '  AA' },
  { id: 'BAMLC0A3CA', name: '  A' },
  { id: 'BAMLC0A4CBBB', name: '  BBB' },
  { id: 'BAMLH0A0HYM2', name: 'U.S. high yield' },
  { id: 'BAMLH0A1HYBB', name: '  BB' },
  { id: 'BAMLH0A2HYB', name: '  B' },
  { id: 'BAMLH0A3HYC', name: '  CCC and lower' },
];

const REGIONS: SpreadSeries[] = [
  { id: 'BAMLC0A0CM', name: 'U.S. investment grade' },
  { id: 'BAMLH0A0HYM2', name: 'U.S. high yield' },
  { id: 'BAMLHE00EHYIOAS', name: 'Euro high yield' },
  { id: 'BAMLEMCBPIOAS', name: 'Emerging markets corporate' },
  { id: 'BAMLEMHBHYCRPIOAS', name: 'Emerging markets high yield' },
  { id: 'BAMLEMRACRPIASIAOAS', name: 'EM Asia' },
  { id: 'BAMLEMRLCRPILAOAS', name: 'EM Latin America' },
  { id: 'BAMLEMRECRPIEMEAOAS', name: 'EM Europe, Middle East, Africa' },
];

/** Latest level, changes and where the level sits in its own history, all in basis points (input is percent). */
export function spreadStats(points: [number, number][]): { asOf: number; level: number; d1w: number | null; d1m: number | null; d1y: number | null; pctile: number | null; low: number; high: number } | null {
  if (!points.length) return null;
  const [t, v] = points[points.length - 1];
  const back = (days: number): number | null => {
    const target = t - days * DAY;
    let hit: number | null = null;
    for (const [pt, pv] of points) {
      if (pt <= target) hit = pv;
      else break;
    }
    return hit === null ? null : Math.round((v - hit) * 1000) / 10;
  };
  const values = points.map((p) => p[1]);
  return {
    asOf: t,
    level: Math.round(v * 1000) / 10,
    d1w: back(7),
    d1m: back(30),
    d1y: back(365),
    pctile: percentileRank(values, v),
    low: Math.round(Math.min(...values) * 1000) / 10,
    high: Math.round(Math.max(...values) * 1000) / 10,
  };
}

function spreadCard(id: string, title: string, description: string, list: SpreadSeries[], chartIds: string[]): CardDef {
  return {
    id,
    title,
    source: 'FRED',
    description,
    async run(ctx) {
      const start = shiftBack(ymd(ctx.now()), '3Y');
      const rows: Row[] = [];
      const lines: { name: string; points: [number, number][] }[] = [];
      const missing: string[] = [];
      let source = 'FRED';
      let asOf = 0;
      let firstError: unknown;
      for (const s of list) {
        try {
          const got = await fred(ctx, s.id, { start, ttl: 3600 });
          const st = spreadStats(got.points);
          if (!st) throw new SourceError(got.source, `no observations for ${s.id}`);
          source = got.source;
          if (st.asOf > asOf) asOf = st.asOf;
          rows.push({ name: s.name, oas: st.level, d1w: st.d1w, d1m: st.d1m, d1y: st.d1y, pctile: st.pctile, low: st.low, high: st.high });
          if (chartIds.includes(s.id)) lines.push({ name: s.name.trim(), points: got.points.map(([t, v]) => [t, Math.round(v * 1000) / 10]) });
        } catch (e) {
          firstError ??= e;
          missing.push(s.name.trim());
        }
      }
      if (!rows.length) throw firstError instanceof Error ? firstError : new SourceError('FRED', 'no spread series available');
      const blocks: Block[] = [
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Index' },
            { key: 'oas', label: 'OAS (bp)', format: 'int' },
            { key: 'd1w', label: '1W chg', format: 'bp' },
            { key: 'd1m', label: '1M chg', format: 'bp' },
            { key: 'd1y', label: '1Y chg', format: 'bp' },
            { key: 'pctile', label: '3Y pctile', format: 'pct', digits: 0 },
            { key: 'low', label: '3Y low', format: 'int' },
            { key: 'high', label: '3Y high', format: 'int' },
          ],
          rows,
          footnote: 'Percentile: share of days in the last three years with a spread at or below today (100% = widest).',
        },
      ];
      if (lines.length) blocks.push({ kind: 'chart', title: 'Option-adjusted spread (bp)', xType: 'time', series: lines, yFormat: 'int' });
      return {
        blocks,
        source,
        sourceUrl: 'https://fred.stlouisfed.org/categories/32297',
        asOf: asOf ? ymd(asOf) : undefined,
        notes: [
          'ICE BofA index option-adjusted spreads over Treasuries, published through FRED, which carries about three years of history for these indices.',
          ...(missing.length ? [`Not available just now: ${missing.join(', ')}.`] : []),
        ],
      };
    },
  };
}

const oasRatings = spreadCard('credit.oas-ratings', 'Credit Spreads by Rating', 'ICE BofA U.S. corporate option-adjusted spreads from AAA to CCC, with changes and a three-year percentile.', RATING_TIERS, ['BAMLC0A0CM', 'BAMLH0A0HYM2', 'BAMLC0A4CBBB']);
const oasRegions = spreadCard('credit.oas-regions', 'Credit Spreads by Region', 'ICE BofA option-adjusted spreads for U.S., euro and emerging market corporate credit.', REGIONS, ['BAMLH0A0HYM2', 'BAMLHE00EHYIOAS', 'BAMLEMCBPIOAS']);

// ---------- CDS indices from swap repository prints ----------

const CDS_INDEX: [RegExp, string, number][] = [
  [/^CDX\.NA\.IG$/i, 'CDX North America IG', 1],
  [/^CDX\.NA\.HY$/i, 'CDX North America HY', 2],
  [/^CDX\.EM$/i, 'CDX Emerging Markets', 3],
  [/^ITRAXX EUROPE$/i, 'iTraxx Europe Main', 4],
  [/^ITRAXX EUROPE CROSSOVER$/i, 'iTraxx Europe Crossover', 5],
];

/** CDX HY and EM trade on price; the investment-grade and iTraxx indices trade on spread. */
const PRICE_QUOTED = /^CDX\.(NA\.HY|EM)/i;

/**
 * Multiplier that turns the reported quote into basis points (spread indices)
 * or percent of par (price indices). Notation codes: 1 = plain amount,
 * 2 = percentage, 3 = decimal fraction, 4 = basis points.
 */
export function quoteScale(notation: string | null | undefined, priceQuoted: boolean): number {
  if (notation === '3') return 10_000;
  if (notation === '2') return priceQuoted ? 1 : 100;
  return 1;
}

export interface CdsIndexRow {
  index: string;
  order: number;
  maturity: string;
  quotedAs: 'spread' | 'price';
  last: number;
  median: number;
  low: number;
  high: number;
  trades: number;
  coupon: number | null;
  time: string;
}

/** On-the-run 5-year level per index: prints whose maturity is 4.4 to 5.6 years out, the busiest maturity per index. */
export function cdsIndexLevels(trades: SdrTrade[], today: string): CdsIndexRow[] {
  interface Group {
    name: string;
    order: number;
    maturity: string;
    raw: string;
    quotes: { time: string; value: number }[];
    coupon: number | null;
  }
  const groups = new Map<string, Group>();
  for (const t of trades) {
    const under = (t.uniqueProductIdentifierUnderlierName ?? '').trim();
    const def = CDS_INDEX.find(([re]) => re.test(under));
    if (!def || t.actionType !== 'NEWT' || t.eventType !== 'TRAD' || !/CDS/i.test(t.uniqueProductIdentifierShortName ?? '') || /Swt|Opt/i.test(t.uniqueProductIdentifierShortName ?? '')) continue;
    const quote = num(t.spreadLeg1 ?? '');
    const maturity = t.expirationDate ?? '';
    const years = (dayMs(maturity) - dayMs(today)) / (365.25 * DAY);
    if (quote === null || quote <= 0 || !(years >= 4.4 && years <= 5.6)) continue;
    const key = `${under}|${maturity}`;
    const g: Group = groups.get(key) ?? { name: def[1], order: def[2], maturity, raw: under, quotes: [], coupon: null };
    g.coupon ??= num(t.fixedRateLeg1 ?? '');
    g.quotes.push({ time: t.executionTimestamp ?? t.eventTimestamp ?? '', value: quote * quoteScale(t.spreadNotationLeg1, PRICE_QUOTED.test(under)) });
    groups.set(key, g);
  }
  const best = new Map<string, Group>();
  for (const g of groups.values()) {
    const cur = best.get(g.raw);
    if (!cur || g.quotes.length > cur.quotes.length) best.set(g.raw, g);
  }
  return [...best.values()]
    .map((g) => {
      const sorted = [...g.quotes].sort((a, b) => b.time.localeCompare(a.time));
      const values = sorted.map((q) => q.value);
      const round = (v: number) => Math.round(v * 100) / 100;
      return {
        index: g.name,
        order: g.order,
        maturity: g.maturity,
        quotedAs: PRICE_QUOTED.test(g.raw) ? ('price' as const) : ('spread' as const),
        last: round(values[0]),
        median: round(median(values) as number),
        low: round(Math.min(...values)),
        high: round(Math.max(...values)),
        trades: values.length,
        coupon: g.coupon === null ? null : Math.round(g.coupon * 10_000),
        time: sorted[0].time,
      };
    })
    .sort((a, b) => a.order - b.order);
}

const cdsIndices: CardDef = {
  id: 'credit.cds-indices',
  title: 'CDS Index Levels (5-year, on the run)',
  source: 'DTCC SDR',
  description: 'CDX IG, HY and EM and iTraxx Main and Crossover 5-year levels, derived from the latest publicly reported index CDS trades.',
  async run(ctx) {
    const rows = cdsIndexLevels(await sdrTrades(ctx, 'CREDITS'), ymd(ctx.now()));
    if (!rows.length) throw new SourceError('DTCC SDR', 'no 5-year CDX or iTraxx index trades in the latest batch of reports');
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'index', label: 'Index' },
            { key: 'quote', label: 'Quoted as' },
            { key: 'last', label: 'Last', format: 'num', digits: 2 },
            { key: 'median', label: 'Median', format: 'num', digits: 2 },
            { key: 'low', label: 'Low', format: 'num', digits: 2 },
            { key: 'high', label: 'High', format: 'num', digits: 2 },
            { key: 'trades', label: 'Trades', format: 'int' },
            { key: 'coupon', label: 'Coupon (bp)', format: 'int' },
            { key: 'maturity', label: 'Maturity', format: 'date' },
            { key: 'time', label: 'Last trade (UTC)', format: 'datetime' },
          ],
          rows: rows.map((r) => ({ ...r, quote: r.quotedAs === 'spread' ? 'spread, bp' : 'price, % of par' })),
        },
      ],
      sourceUrl: SDR_URL,
      asOf: rows.map((r) => r.time).sort().pop(),
      notes: [
        'Derived here from index CDS executions disseminated by the DTCC swap data repository under CFTC rules: for each index, the maturity about five years out with the most trades in the latest batch (about a hundred reports), so an index that did not just trade is absent.',
        'CDX HY and CDX EM are quoted on price by market convention (above 100 means the spread is below the fixed coupon); the others are quoted on spread. These are trade prints, not an official closing level.',
      ],
    };
  },
};

// ---------- Bond pricer ----------

async function treasuryAt(ctx: Ctx, years: number): Promise<{ yield: number; date: string } | null> {
  const today = ymd(ctx.now());
  const series = tableToSeries(await treasuryTable(ctx, 'daily_treasury_yield_curve', yearsFor([today])));
  const latest = latestDate(series);
  if (!latest) return null;
  const { values } = curveAt(series, latest);
  const knots = series.flatMap((s, i): [number, number][] => (values[i] == null ? [] : [[s.years, values[i] as number]]));
  const y = interpolate(knots, Math.min(Math.max(years, knots[0]?.[0] ?? years), knots[knots.length - 1]?.[0] ?? years));
  return y === null ? null : { yield: y, date: latest };
}

const bondPricer: CardDef = {
  id: 'credit.bond-pricer',
  title: 'Bond Pricer',
  source: 'Computed',
  description: 'Price or yield of a fixed-coupon bond with accrued interest, Macaulay and modified duration, convexity, DV01 and the spread over the matching Treasury.',
  params: [
    { name: 'coupon', label: 'Coupon %', default: '5', hint: 'annual coupon rate, e.g. 4.25' },
    { name: 'maturity', label: 'Maturity', default: '10Y', hint: 'YYYY-MM-DD, or a tenor such as 7Y' },
    { name: 'price', label: 'Clean price', default: '98.5', hint: 'per 100 face; ignored when a yield is given' },
    { name: 'yield', label: 'Yield %', default: '', hint: 'leave empty to solve the yield from the price' },
    { name: 'frequency', label: 'Coupons per year', default: '2', choices: ['1', '2', '4', '12'] },
  ],
  async run(ctx, p) {
    const settle = ymd(ctx.now());
    const coupon = num(p.coupon ?? '');
    const frequency = Number(p.frequency ?? '2');
    if (coupon === null || coupon < 0) throw new SourceError('Bond pricer', 'coupon must be a number, zero or more');
    if (![1, 2, 4, 12].includes(frequency)) throw new SourceError('Bond pricer', 'frequency must be 1, 2, 4 or 12');
    let bond: Bond;
    let y: number;
    const givenYield = num(p.yield ?? '');
    try {
      bond = { coupon, maturity: resolveMaturity(p.maturity ?? '10Y', settle), frequency };
      if (givenYield !== null) y = givenYield;
      else {
        const price = num(p.price ?? '');
        if (price === null) throw new Error('give a clean price or a yield');
        y = yieldFromPrice(bond, settle, price);
      }
    } catch (e) {
      throw new SourceError('Bond pricer', (e as Error).message);
    }
    const v = valueAtYield(bond, settle, y);
    const life = yearsBetween(settle, bond.maturity);
    const notes = [
      `Settlement today (${settle}); street convention with actual/actual accrual and ${frequency}x compounding. ${givenYield !== null ? 'Price solved from the yield.' : 'Yield solved from the clean price.'}`,
    ];
    let gov: { yield: number; date: string } | null = null;
    try {
      gov = await treasuryAt(ctx, life);
    } catch (e) {
      notes.push(`Treasury curve unavailable, so no spread is shown (${(e as Error).message}).`);
    }
    if (gov) notes.push(`G-spread is against the Treasury par curve of ${gov.date}, interpolated linearly to ${life.toFixed(2)} years.`);
    const shifts = [-100, -50, -25, -10, 0, 10, 25, 50, 100];
    return {
      blocks: [
        {
          kind: 'stats',
          title: `${coupon}% due ${bond.maturity}`,
          items: [
            { label: 'Clean price', value: v.clean, format: 'num', digits: 4 },
            { label: 'Yield to maturity', value: v.yield, format: 'pct', digits: 4 },
            { label: 'Accrued interest', value: v.accrued, format: 'num', digits: 4 },
            { label: 'Dirty price', value: v.dirty, format: 'num', digits: 4 },
            { label: 'Macaulay duration (y)', value: v.macaulay, format: 'num', digits: 3 },
            { label: 'Modified duration', value: v.modified, format: 'num', digits: 3 },
            { label: 'Convexity', value: v.convexity, format: 'num', digits: 2 },
            { label: 'DV01 per 100 face', value: v.dv01, format: 'num', digits: 4 },
            { label: 'DV01 per $1M face', value: v.dv01 * 10_000, format: 'usd', digits: 0 },
            { label: 'Current yield', value: v.clean > 0 ? (coupon / v.clean) * 100 : null, format: 'pct', digits: 3 },
            { label: 'Years to maturity', value: life, format: 'num', digits: 2 },
            { label: 'Next coupon', value: v.nextCoupon },
            ...(gov
              ? [
                  { label: 'Treasury yield, same maturity', value: gov.yield, format: 'pct' as const, digits: 3 },
                  { label: 'G-spread', value: Math.round((v.yield - gov.yield) * 1000) / 10, format: 'bp' as const, digits: 1 },
                ]
              : []),
          ],
        },
        {
          kind: 'table',
          title: 'Price if the yield moves',
          columns: [
            { key: 'shift', label: 'Yield shift', format: 'bp' },
            { key: 'yield', label: 'Yield', format: 'pct', digits: 3 },
            { key: 'price', label: 'Clean price', format: 'num', digits: 3 },
            { key: 'change', label: 'Price chg', format: 'signedPct', digits: 2 },
          ],
          rows: shifts.map((s) => {
            const w = valueAtYield(bond, settle, y + s / 100);
            return { shift: s, yield: w.yield, price: w.clean, change: ((w.clean - v.clean) / v.clean) * 100 };
          }),
        },
      ],
      asOf: settle,
      notes,
    };
  },
};

// ---------- Debt maturity wall from 10-K XBRL facts ----------

const MATURITY_TAGS: [string, string][] = [
  ['LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths', 'Year 1'],
  ['LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo', 'Year 2'],
  ['LongTermDebtMaturitiesRepaymentsOfPrincipalInYearThree', 'Year 3'],
  ['LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFour', 'Year 4'],
  ['LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFive', 'Year 5'],
  ['LongTermDebtMaturitiesRepaymentsOfPrincipalAfterYearFive', 'Later'],
];

export interface XbrlFact {
  end: string;
  val: number;
  form?: string;
  filed?: string;
  fy?: number;
}

/** The value reported in the most recent annual report (10-K, 20-F or 40-F): latest period end, then latest filing. */
export function latestAnnualFact(facts: XbrlFact[]): XbrlFact | null {
  const annual = facts.filter((f) => /^(10-K|20-F|40-F)/.test(f.form ?? '') && Number.isFinite(f.val));
  if (!annual.length) return null;
  return annual.reduce((a, b) => (b.end > a.end || (b.end === a.end && (b.filed ?? '') > (a.filed ?? '')) ? b : a));
}

interface ConceptBody {
  entityName?: string;
  units?: Record<string, XbrlFact[]>;
}

async function secCik(ctx: Ctx, symbol: string): Promise<{ cik: string; name: string }> {
  const want = symbol.trim().toUpperCase().replace('.', '-');
  if (/^\d{1,10}$/.test(want)) return { cik: want.padStart(10, '0'), name: `CIK ${want}` };
  const all = await ctx.http.json<Record<string, { cik_str: number; ticker: string; title: string }>>('https://www.sec.gov/files/company_tickers.json', { source: 'SEC EDGAR', ttl: 86_400, timeoutMs: 30_000 });
  const hit = Object.values(all).find((c) => c.ticker.toUpperCase() === want);
  if (!hit) throw new SourceError('SEC EDGAR', `no SEC registrant with ticker ${symbol}`);
  return { cik: String(hit.cik_str).padStart(10, '0'), name: hit.title };
}

const maturityWall: CardDef = {
  id: 'credit.maturity-wall',
  title: 'Debt Maturity Wall',
  source: 'SEC EDGAR',
  description: "Long-term debt principal repayments by year from the issuer's latest annual report (XBRL facts).",
  params: [{ name: 'symbol', label: 'Issuer', default: 'AAPL', hint: 'U.S. ticker, e.g. T, F, AAPL' }],
  async run(ctx, p) {
    const { cik, name } = await secCik(ctx, p.symbol ?? 'AAPL');
    const got: { label: string; fact: XbrlFact }[] = [];
    let entity = name;
    for (const [tag, label] of MATURITY_TAGS) {
      try {
        const body = await ctx.http.json<ConceptBody>(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`, { source: 'SEC EDGAR', ttl: 21_600 });
        entity = body.entityName ?? entity;
        const fact = latestAnnualFact(body.units?.USD ?? Object.values(body.units ?? {})[0] ?? []);
        if (fact) got.push({ label, fact });
      } catch (e) {
        if (!(e instanceof SourceError) || e.status !== 404) throw e;
      }
    }
    if (!got.length) throw new SourceError('SEC EDGAR', `${entity} does not tag a long-term debt maturity schedule in its annual report`);
    // Only the figures from the newest report: an older tag the company stopped using must not be mixed in.
    const end = got.reduce((a, b) => (b.fact.end > a ? b.fact.end : a), '');
    // Some issuers stopped tagging the schedule years ago; an old wall is worse than none.
    if (ctx.now().getTime() - dayMs(end) > 800 * DAY) {
      throw new SourceError('SEC EDGAR', `${entity} last tagged a long-term debt maturity schedule for ${end}; its newer annual reports do not carry one`);
    }
    const current = got.filter((g) => g.fact.end === end);
    // Bucket i is the fiscal year that ends i + 1 years after the balance-sheet date, named by the year it ends in.
    const endYear = Number(end.slice(0, 4));
    const total = current.reduce((n, g) => n + g.fact.val, 0);
    const rows: Row[] = current.map((g) => {
      const i = MATURITY_TAGS.findIndex((t) => t[1] === g.label);
      return { bucket: g.label === 'Later' ? `After FY${endYear + 5}` : `FY${endYear + i + 1}`, amount: g.fact.val, share: total ? (g.fact.val / total) * 100 : null };
    });
    return {
      blocks: [
        {
          kind: 'chart',
          title: `${entity}: principal due by fiscal year`,
          xType: 'category',
          style: 'bar',
          categories: rows.map((r) => String(r.bucket)),
          series: [{ name: 'Principal due', points: rows.map((r, i): [number, number] => [i, r.amount as number]) }],
          yFormat: 'usdCompact',
        },
        {
          kind: 'table',
          columns: [
            { key: 'bucket', label: 'Due in' },
            { key: 'amount', label: 'Principal', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct', digits: 1 },
          ],
          rows: [...rows, { bucket: 'Total scheduled', amount: total, share: 100 }],
        },
      ],
      sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K`,
      asOf: end,
      notes: [
        `Balance-sheet date ${end}, filed ${current[0].fact.filed ?? 'n/a'}. Scheduled principal repayments of long-term debt as tagged in the financial statement notes; they can differ from carrying value (discounts, hedges, leases).`,
        ...(current.length < MATURITY_TAGS.length ? ['Some years are not tagged in this filing and are missing above.'] : []),
      ],
    };
  },
};

// ---------- Private credit boards ----------

function board(id: string, title: string, description: string, symbols: [string, string][]): CardDef {
  return {
    id,
    title,
    source: 'Market data',
    description,
    async run(ctx) {
      const got = await returnsBoard(ctx, symbols.map(([symbol, label]) => ({ symbol, label })), title);
      return { blocks: [got.block], source: got.source, notes: got.notes };
    },
  };
}

const bdcs = board('credit.bdcs', 'Listed BDCs', 'Business development companies: the listed lenders to private middle-market companies.', [
  ['ARCC', 'Ares Capital'],
  ['OBDC', 'Blue Owl Capital Corp'],
  ['BXSL', 'Blackstone Secured Lending'],
  ['FSK', 'FS KKR Capital'],
  ['MAIN', 'Main Street Capital'],
  ['GBDC', 'Golub Capital BDC'],
  ['HTGC', 'Hercules Capital'],
  ['TSLX', 'Sixth Street Specialty Lending'],
  ['PSEC', 'Prospect Capital'],
  ['OCSL', 'Oaktree Specialty Lending'],
  ['CSWC', 'Capital Southwest'],
  ['GSBD', 'Goldman Sachs BDC'],
  ['NMFC', 'New Mountain Finance'],
  ['BBDC', 'Barings BDC'],
  ['CGBD', 'Carlyle Secured Lending'],
  ['BIZD', 'VanEck BDC Income ETF'],
]);

const loanEtfs = board('credit.loan-clo-etfs', 'Leveraged Loan and CLO ETFs', 'Exchange-traded funds holding senior loans, CLO tranches and private credit.', [
  ['BKLN', 'Invesco Senior Loan'],
  ['SRLN', 'SPDR Blackstone Senior Loan'],
  ['FTSL', 'First Trust Senior Loan'],
  ['FLBL', 'Franklin Senior Loan'],
  ['JAAA', 'Janus Henderson AAA CLO'],
  ['JBBB', 'Janus Henderson B-BBB CLO'],
  ['CLOA', 'iShares AAA CLO Active'],
  ['CLOI', 'VanEck CLO'],
  ['CLOZ', 'Panagram BBB-B CLO'],
  ['PRIV', 'SPDR SSGA Apollo IG Public & Private Credit'],
  ['HYG', 'iShares High Yield Corporate (reference)'],
]);

const altManagers = board('credit.alt-managers', 'Listed Alternative Asset Managers', 'The listed managers of private credit, private equity and real assets.', [
  ['BX', 'Blackstone'],
  ['APO', 'Apollo Global Management'],
  ['KKR', 'KKR'],
  ['ARES', 'Ares Management'],
  ['BAM', 'Brookfield Asset Management'],
  ['CG', 'Carlyle Group'],
  ['OWL', 'Blue Owl Capital'],
  ['TPG', 'TPG'],
  ['HLNE', 'Hamilton Lane'],
  ['STEP', 'StepStone Group'],
]);

// ---------- Lending standards and corporate leverage (FRED) ----------

const sloos: CardDef = {
  id: 'credit.sloos',
  title: 'Bank Lending Standards (Fed SLOOS)',
  source: 'FRED',
  description: 'Senior Loan Officer Opinion Survey: net share of banks tightening standards, and loan demand, for business and consumer credit.',
  async run(ctx) {
    const list = [
      { id: 'DRTSCILM', name: 'Tightening: C&I, large and mid firms' },
      { id: 'DRTSCIS', name: 'Tightening: C&I, small firms' },
      { id: 'DRTSCLCC', name: 'Tightening: credit cards' },
      { id: 'DRSDCILM', name: 'Stronger demand: C&I, large and mid firms' },
    ];
    const start = shiftBack(ymd(ctx.now()), '20Y');
    const got = await fredLines(ctx, list, { start, ttl: 21_600 });
    const chart: Block = { kind: 'chart', title: 'Net percent of banks', xType: 'time', series: got.lines, yFormat: 'pct', yDigits: 1 };
    const rows: Row[] = got.lines.map((s) => {
      const last = s.points[s.points.length - 1];
      const prev = s.points[s.points.length - 2];
      const year = s.points[s.points.length - 5];
      return { name: s.name, quarter: last ? ymd(last[0]) : '', value: last?.[1], prev: prev?.[1], yearAgo: year?.[1] };
    });
    return {
      blocks: [
        chart,
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Series' },
            { key: 'quarter', label: 'Quarter', format: 'date' },
            { key: 'value', label: 'Latest', format: 'pct', digits: 1 },
            { key: 'prev', label: 'Prior qtr', format: 'pct', digits: 1 },
            { key: 'yearAgo', label: 'Year ago', format: 'pct', digits: 1 },
          ],
          rows,
        },
      ],
      source: got.source,
      sourceUrl: 'https://www.federalreserve.gov/data/sloos.htm',
      asOf: rows.map((r) => String(r.quarter)).sort().pop(),
      notes: [
        'Net percent = share of banks tightening (or seeing stronger demand) minus the share easing (or seeing weaker demand). Above zero on standards means credit is getting harder to obtain.',
        ...(got.missing.length ? [`Not available just now: ${got.missing.join(', ')}.`] : []),
      ],
    };
  },
};

const corporateLeverage: CardDef = {
  id: 'credit.corporate-leverage',
  title: 'U.S. Corporate Debt and Leverage',
  source: 'FRED',
  description: 'Nonfinancial corporate debt outstanding and debt as a share of the market value of equity (Fed Financial Accounts).',
  async run(ctx) {
    const start = shiftBack(ymd(ctx.now()), '20Y');
    const ratio = await fred(ctx, 'NCBCMDPMVCE', { start, ttl: 21_600 });
    const debt = await fred(ctx, 'BCNSDODNS', { start, ttl: 21_600 });
    const scale = (pts: [number, number][]): [number, number][] => pts.map(([t, v]) => [t, v * 1e6]);
    const lastR = ratio.points[ratio.points.length - 1];
    const lastD = debt.points[debt.points.length - 1];
    const yearD = debt.points[debt.points.length - 5];
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Debt to equity market value', value: lastR?.[1], format: 'pct', digits: 1 },
            { label: 'Debt outstanding', value: lastD ? lastD[1] * 1e6 : null, format: 'usdCompact' },
            { label: 'Debt growth, 4 quarters', value: lastD && yearD ? ((lastD[1] - yearD[1]) / yearD[1]) * 100 : null, format: 'signedPct' },
            { label: 'Quarter', value: lastD ? ymd(lastD[0]) : '' },
          ],
        },
        { kind: 'chart', title: 'Debt as a percent of equity market value', xType: 'time', series: [{ name: 'Nonfinancial corporate', points: ratio.points }], yFormat: 'pct', yDigits: 1 },
        { kind: 'chart', title: 'Debt securities and loans outstanding', xType: 'time', series: [{ name: 'Nonfinancial corporate', points: scale(debt.points) }], yFormat: 'usdCompact' },
      ],
      source: ratio.source,
      sourceUrl: 'https://www.federalreserve.gov/releases/z1/',
      asOf: lastD ? ymd(lastD[0]) : undefined,
      notes: ['Quarterly, from the Federal Reserve Z.1 Financial Accounts via FRED. The ratio falls when equity prices rise even if debt does not.'],
    };
  },
};

export const creditCards: CardDef[] = [oasRatings, oasRegions, cdsIndices, bondPricer, maturityWall, bdcs, loanEtfs, altManagers, sloos, corporateLeverage];
