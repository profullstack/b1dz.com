/** DeFi from DefiLlama's open API: value locked by chain and protocol, DEX volume, fees and revenue, yields and exploits. */
import { SourceError, type CardDef, type Ctx, type Row } from '../../types.js';
import { DAY, RANGE_CHOICES, changeOver, clip, list, minuteStamp, n, rec, share, str, sum, titleCase } from './util.js';

export const LLAMA = 'DefiLlama';

/** The big DefiLlama lists run to several megabytes, so they are cached for an hour. */
export async function llama<T = unknown>(ctx: Ctx, url: string, ttl = 3600): Promise<T> {
  return ctx.http.json<T>(url, { source: LLAMA, ttl, timeoutMs: 40_000 });
}

/** DefiLlama date/value rows (`{date: seconds, tvl}`) to an ascending [ms, value] series. */
export function parseDated(body: unknown, key: string): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of list(body)) {
    const p = rec(raw);
    const t = n(p.date);
    const v = n(p[key]);
    if (t !== null && v !== null) out.push([t * 1000, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function seriesStats(pts: [number, number][], label: string) {
  const last = pts[pts.length - 1];
  const peak = pts.reduce((m, p) => (p[1] > m[1] ? p : m), pts[0]);
  return [
    { label, value: last[1], format: 'usdCompact' as const },
    { label: '1 day', value: changeOver(pts, 1), format: 'signedPct' as const },
    { label: '7 days', value: changeOver(pts, 7), format: 'signedPct' as const },
    { label: '30 days', value: changeOver(pts, 30), format: 'signedPct' as const },
    { label: '1 year', value: changeOver(pts, 365), format: 'signedPct' as const },
    { label: 'Record', value: peak[1], format: 'usdCompact' as const },
    { label: 'Record set', value: new Date(peak[0]).toISOString().slice(0, 10) },
    { label: 'From record', value: (last[1] / peak[1] - 1) * 100, format: 'signedPct' as const },
  ];
}

// ---------------------------------------------------------------- TVL

/** DefiLlama answers 404 for a chain name it does not know; say that instead of the status code. */
export function unknownChain(chain: string): (e: unknown) => never {
  return (e) => {
    if (e instanceof SourceError && (e.status === 404 || e.status === 400)) throw new SourceError(LLAMA, `no chain named "${chain}" (use DefiLlama's name, for example Ethereum, Solana, BSC, Base, Arbitrum, Tron)`);
    throw e;
  };
}

const tvl: CardDef = {
  id: 'crypto.defi-tvl',
  title: 'DeFi Total Value Locked',
  source: LLAMA,
  description: 'The dollar value locked in DeFi protocols, for all chains or one chain, through time.',
  params: [
    { name: 'chain', label: 'Chain', default: 'All', hint: 'All, Ethereum, Solana, BSC, Base, Arbitrum, Tron ...' },
    { name: 'range', label: 'Range', default: '2Y', choices: RANGE_CHOICES },
  ],
  async run(ctx, params) {
    const chain = (params.chain ?? 'All').trim();
    const all = !chain || chain.toLowerCase() === 'all';
    const pts = parseDated(await llama(ctx, `https://api.llama.fi/v2/historicalChainTvl${all ? '' : `/${encodeURIComponent(chain)}`}`).catch(unknownChain(chain)), 'tvl').filter((p) => p[1] > 0);
    if (pts.length < 2) throw new SourceError(LLAMA, `no value-locked history for "${chain}"`);
    return {
      blocks: [
        { kind: 'stats', items: seriesStats(pts, all ? 'Value locked, all chains' : `Value locked on ${chain}`) },
        { kind: 'chart', title: `${all ? 'DeFi' : chain}: total value locked`, xType: 'time', yFormat: 'usdCompact', series: [{ name: 'TVL', points: clip(pts, params.range, '2Y') }] },
      ],
      sourceUrl: all ? 'https://defillama.com/' : `https://defillama.com/chain/${encodeURIComponent(chain)}`,
      asOf: new Date(pts[pts.length - 1][0]).toISOString().slice(0, 10),
      notes: ['Value locked is the dollar value of assets deposited in protocols, so it moves with coin prices as well as with deposits. Liquid staking and double-counted deposits are excluded, as on DefiLlama\'s default view.'],
    };
  },
};

export interface ChainTvl {
  name: string;
  token: string;
  tvl: number;
}

/** DefiLlama `GET /v2/chains` to chains, largest first. */
export function parseChains(body: unknown): ChainTvl[] {
  const out: ChainTvl[] = [];
  for (const raw of list(body)) {
    const c = rec(raw);
    const v = n(c.tvl);
    if (!str(c.name) || v === null || !(v > 0)) continue;
    out.push({ name: str(c.name), token: str(c.tokenSymbol), tvl: v });
  }
  return out.sort((a, b) => b.tvl - a.tvl);
}

const chains: CardDef = {
  id: 'crypto.defi-chains',
  title: 'Value Locked by Chain',
  source: LLAMA,
  description: 'Blockchains ranked by the value locked in their DeFi protocols, with each chain\'s share.',
  async run(ctx) {
    const all = parseChains(await llama(ctx, 'https://api.llama.fi/v2/chains', 1800));
    if (!all.length) throw new SourceError(LLAMA, 'no chains returned');
    const total = sum(all.map((c) => c.tvl));
    const top = all.slice(0, 12);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Value locked, all chains', value: total, format: 'usdCompact' },
            { label: 'Chains with value locked', value: all.length, format: 'int' },
            { label: `${all[0].name} share`, value: share(all[0].tvl, total), format: 'pct' },
            { label: 'Top 5 chains', value: share(sum(all.slice(0, 5).map((c) => c.tvl)), total), format: 'pct' },
          ],
        },
        {
          kind: 'chart',
          title: 'Value locked by chain (USD)',
          xType: 'category',
          style: 'bar',
          yFormat: 'usdCompact',
          categories: top.map((c) => c.name),
          series: [{ name: 'TVL', points: top.map((c, i): [number, number] => [i, c.tvl]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Chain' },
            { key: 'token', label: 'Token' },
            { key: 'tvl', label: 'Value locked', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
          ],
          rows: all.slice(0, 40).map((c, i) => ({ rank: i + 1, ...c, share: share(c.tvl, total) })),
        },
      ],
      sourceUrl: 'https://defillama.com/chains',
      asOf: minuteStamp(ctx),
    };
  },
};

export interface Protocol {
  name: string;
  category: string;
  chains: string[];
  tvl: number;
  chg1d: number | null;
  chg7d: number | null;
  mcap: number | null;
  ethereumTvl: number | null;
}

/** DefiLlama `GET /protocols` to protocols, largest first. */
export function parseProtocols(body: unknown): Protocol[] {
  const out: Protocol[] = [];
  for (const raw of list(body)) {
    const p = rec(raw);
    const v = n(p.tvl);
    if (!str(p.name) || v === null || !(v > 0)) continue;
    out.push({ name: str(p.name), category: str(p.category), chains: list(p.chains).map(str), tvl: v, chg1d: n(p.change_1d), chg7d: n(p.change_7d), mcap: n(p.mcap), ethereumTvl: n(rec(p.chainTvls).Ethereum) });
  }
  return out.sort((a, b) => b.tvl - a.tvl);
}

/** Centralized exchanges and whole chains are listed by DefiLlama but are not DeFi protocols. */
const NOT_DEFI = new Set(['CEX', 'Chain']);

export async function protocols(ctx: Ctx): Promise<Protocol[]> {
  const all = parseProtocols(await llama(ctx, 'https://api.llama.fi/protocols', 3600));
  if (!all.length) throw new SourceError(LLAMA, 'no protocols returned');
  return all;
}

const CATEGORY_CHOICES = ['All', 'Lending', 'Liquid Staking', 'Dexs', 'Restaking', 'Liquid Restaking', 'Bridge', 'CDP', 'RWA', 'Derivatives', 'Yield', 'Basis Trading', 'Stablecoin Issuer', 'Prediction Market'];

const protocolsCard: CardDef = {
  id: 'crypto.defi-protocols',
  title: 'Top DeFi Protocols',
  source: LLAMA,
  description: 'The largest DeFi protocols by value locked, for all categories or one (lending, liquid staking, DEXs, restaking and others).',
  params: [{ name: 'category', label: 'Category', default: 'All', choices: CATEGORY_CHOICES }],
  async run(ctx, params) {
    const want = (params.category ?? 'All').trim().toLowerCase();
    const all = (await protocols(ctx)).filter((p) => !NOT_DEFI.has(p.category));
    const rows = want === 'all' || !want ? all : all.filter((p) => p.category.toLowerCase() === want);
    if (!rows.length) throw new SourceError(LLAMA, `no protocols in category "${params.category}"`);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Protocol', maxWidth: 28 },
            { key: 'category', label: 'Category', maxWidth: 20 },
            { key: 'chain', label: 'Chain', maxWidth: 18 },
            { key: 'tvl', label: 'Value locked', format: 'usdCompact' },
            { key: 'chg1d', label: '1d', format: 'signedPct' },
            { key: 'chg7d', label: '7d', format: 'signedPct' },
            { key: 'mcap', label: 'Token market cap', format: 'usdCompact' },
            { key: 'ratio', label: 'Mcap / TVL', format: 'num', digits: 2 },
          ],
          rows: rows.slice(0, 40).map((p, i) => ({
            rank: i + 1,
            name: p.name,
            category: p.category,
            chain: p.chains.length > 1 ? `${p.chains[0]} +${p.chains.length - 1}` : (p.chains[0] ?? ''),
            tvl: p.tvl,
            chg1d: p.chg1d,
            chg7d: p.chg7d,
            mcap: p.mcap,
            ratio: p.mcap ? p.mcap / p.tvl : null,
          })),
        },
      ],
      sourceUrl: 'https://defillama.com/protocols',
      asOf: minuteStamp(ctx),
      notes: ['Each protocol version is its own row, as DefiLlama lists it. Centralized exchanges are on the Exchanges dashboard. Bridges count the assets locked to back tokens on other chains. Liquid staking and restaking deposits also appear inside other protocols, so categories overlap.'],
    };
  },
};

const categoriesCard: CardDef = {
  id: 'crypto.defi-categories',
  title: 'Value Locked by Category',
  source: LLAMA,
  description: 'DeFi value locked grouped by what protocols do: lending, liquid staking, exchanges, restaking, bridges and the rest.',
  async run(ctx) {
    const all = (await protocols(ctx)).filter((p) => !NOT_DEFI.has(p.category));
    const by = new Map<string, { tvl: number; count: number; top: string }>();
    for (const p of all) {
      const c = by.get(p.category) ?? { tvl: 0, count: 0, top: p.name };
      c.tvl += p.tvl;
      c.count += 1;
      by.set(p.category, c);
    }
    const rows = [...by.entries()].sort((a, b) => b[1].tvl - a[1].tvl);
    const total = sum(rows.map((r) => r[1].tvl));
    const top = rows.slice(0, 12);
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Value locked by category (USD)',
          xType: 'category',
          style: 'bar',
          yFormat: 'usdCompact',
          categories: top.map((r) => r[0]),
          series: [{ name: 'TVL', points: top.map((r, i): [number, number] => [i, r[1].tvl]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'category', label: 'Category', maxWidth: 28 },
            { key: 'tvl', label: 'Value locked', format: 'usdCompact' },
            { key: 'share', label: 'Share of sum', format: 'pct' },
            { key: 'count', label: 'Protocols', format: 'int' },
            { key: 'top', label: 'Largest', maxWidth: 26 },
          ],
          rows: rows.slice(0, 30).map(([category, c]) => ({ category, tvl: c.tvl, share: share(c.tvl, total), count: c.count, top: c.top })),
        },
      ],
      sourceUrl: 'https://defillama.com/categories',
      asOf: minuteStamp(ctx),
      notes: ['Categories overlap: a deposit in a liquid staking protocol can be lent out again and counted in lending. The sum here is larger than the headline DeFi total, which removes that double counting.'],
    };
  },
};

// ---------------------------------------------------------------- DEX volume, fees

export interface Dimension {
  name: string;
  category: string;
  chains: string[];
  d1: number;
  d7: number | null;
  d30: number | null;
  y1: number | null;
  /** This week against last week, percent. */
  wow: number | null;
  breakdown24h: Record<string, number>;
}

/** A DefiLlama `overview/*` protocol list (DEX volume, fees, revenue), largest by 24 hours first. */
export function parseDimension(body: unknown): Dimension[] {
  const out: Dimension[] = [];
  for (const raw of list(rec(body).protocols)) {
    const p = rec(raw);
    const d1 = n(p.total24h);
    if (!str(p.name) || d1 === null || !(d1 > 0)) continue;
    const breakdown24h: Record<string, number> = {};
    for (const [chain, parts] of Object.entries(rec(p.breakdown24h))) breakdown24h[chain] = sum(Object.values(rec(parts)).map(n));
    out.push({ name: str(p.displayName) || str(p.name), category: str(p.category), chains: list(p.chains).map(str), d1, d7: n(p.total7d), d30: n(p.total30d), y1: n(p.total1y), wow: n(p.change_7dover7d), breakdown24h });
  }
  return out.sort((a, b) => b.d1 - a.d1);
}

/** `totalDataChart` ([seconds, value] pairs) to an ascending [ms, value] series. */
export function parseTotalChart(body: unknown): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of list(rec(body).totalDataChart)) {
    const t = n(list(raw)[0]);
    const v = n(list(raw)[1]);
    if (t !== null && v !== null) out.push([t * 1000, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const DEX_URL = 'https://api.llama.fi/overview/dexs?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true';

const dexVolume: CardDef = {
  id: 'crypto.dex-volume',
  title: 'DEX Volume',
  source: LLAMA,
  description: 'Spot trading volume on decentralized exchanges: the daily total through time and the largest exchanges over 24 hours, 7 days and 30 days.',
  params: [{ name: 'range', label: 'Range', default: '1Y', choices: RANGE_CHOICES }],
  async run(ctx, params) {
    const body = await llama(ctx, DEX_URL);
    const all = parseDimension(body);
    if (!all.length) throw new SourceError(LLAMA, 'no DEX volume returned');
    const b = rec(body);
    const total = n(b.total24h) ?? sum(all.map((d) => d.d1));
    const chart = parseTotalChart(body);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Volume, 24h', value: total, format: 'usdCompact' },
            { label: 'Against the day before', value: n(b.change_1d), format: 'signedPct' },
            { label: 'Volume, 7 days', value: n(b.total7d), format: 'usdCompact' },
            { label: 'Week on week', value: n(b.change_7dover7d), format: 'signedPct' },
            { label: 'Volume, 30 days', value: n(b.total30d), format: 'usdCompact' },
            { label: 'Month on month', value: n(b.change_30dover30d), format: 'signedPct' },
            { label: 'Volume, 1 year', value: n(b.total1y), format: 'usdCompact' },
            { label: 'Exchanges with volume', value: all.length, format: 'int' },
          ],
        },
        ...(chart.length > 1 ? [{ kind: 'chart' as const, title: 'DEX volume per day (USD)', xType: 'time' as const, yFormat: 'usdCompact' as const, series: [{ name: 'Volume', points: clip(chart, params.range) }] }] : []),
        {
          kind: 'table',
          title: 'Largest exchanges, last 24 hours',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Exchange', maxWidth: 26 },
            { key: 'chain', label: 'Chain', maxWidth: 18 },
            { key: 'd1', label: '24h', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'd7', label: '7d', format: 'usdCompact' },
            { key: 'd30', label: '30d', format: 'usdCompact' },
            { key: 'wow', label: 'Week on week', format: 'signedPct' },
          ],
          rows: all.slice(0, 30).map((d, i) => ({ rank: i + 1, name: d.name, chain: d.chains.length > 1 ? `${d.chains[0]} +${d.chains.length - 1}` : (d.chains[0] ?? ''), d1: d.d1, share: share(d.d1, total), d7: d.d7, d30: d.d30, wow: d.wow })),
        },
      ],
      sourceUrl: 'https://defillama.com/dexs',
      asOf: minuteStamp(ctx),
      notes: ['Spot volume traded on chain, in dollars. Each protocol version is its own row. The last day on the chart can be incomplete.'],
    };
  },
};

const dexChains: CardDef = {
  id: 'crypto.dex-chains',
  title: 'DEX Volume by Chain',
  source: LLAMA,
  description: 'Which chains the last 24 hours of decentralized exchange volume traded on, with the largest exchange on each.',
  async run(ctx) {
    const all = parseDimension(await llama(ctx, DEX_URL));
    const by = new Map<string, { vol: number; top: string; topVol: number; count: number }>();
    for (const d of all) {
      for (const [chain, vol] of Object.entries(d.breakdown24h)) {
        if (!(vol > 0)) continue;
        const c = by.get(chain) ?? { vol: 0, top: d.name, topVol: 0, count: 0 };
        c.vol += vol;
        c.count += 1;
        if (vol > c.topVol) {
          c.top = d.name;
          c.topVol = vol;
        }
        by.set(chain, c);
      }
    }
    const rows = [...by.entries()].sort((a, b) => b[1].vol - a[1].vol);
    if (!rows.length) throw new SourceError(LLAMA, 'no chain breakdown returned');
    const total = sum(rows.map((r) => r[1].vol));
    const top = rows.slice(0, 12);
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'DEX volume by chain, 24 hours (USD)',
          xType: 'category',
          style: 'bar',
          yFormat: 'usdCompact',
          categories: top.map((r) => titleCase(r[0])),
          series: [{ name: 'Volume', points: top.map((r, i): [number, number] => [i, r[1].vol]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'chain', label: 'Chain' },
            { key: 'vol', label: '24h volume', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'count', label: 'Exchanges', format: 'int' },
            { key: 'top', label: 'Largest', maxWidth: 26 },
            { key: 'topShare', label: 'Its share of the chain', format: 'pct' },
          ],
          rows: rows.slice(0, 30).map(([chain, c]) => ({ chain: titleCase(chain), vol: c.vol, share: share(c.vol, total), count: c.count, top: c.top, topShare: share(c.topVol, c.vol) })),
        },
      ],
      sourceUrl: 'https://defillama.com/dexs/chains',
      asOf: minuteStamp(ctx),
      notes: ['Chain names are DefiLlama\'s short codes (bsc is BNB Chain, xdai is Gnosis).'],
    };
  },
};

const KINDS: Record<string, { label: string; query: string }> = {
  fees: { label: 'Fees', query: '' },
  revenue: { label: 'Revenue', query: '&dataType=dailyRevenue' },
};

const fees: CardDef = {
  id: 'crypto.defi-fees',
  title: 'Fees and Revenue',
  source: LLAMA,
  description: 'What users pay protocols and chains (fees), or the part the protocol keeps (revenue): 24 hours, 7 days, 30 days and one year.',
  params: [{ name: 'kind', label: 'Show', default: 'fees', choices: Object.keys(KINDS) }],
  async run(ctx, params) {
    const kind = KINDS[params.kind] ? params.kind : 'fees';
    const body = await llama(ctx, `https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true${KINDS[kind].query}`);
    const all = parseDimension(body);
    if (!all.length) throw new SourceError(LLAMA, `no ${kind} returned`);
    const b = rec(body);
    const total = n(b.total24h) ?? sum(all.map((d) => d.d1));
    const label = KINDS[kind].label;
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: `${label}, 24h`, value: total, format: 'usdCompact' },
            { label: `${label}, 7 days`, value: n(b.total7d), format: 'usdCompact' },
            { label: 'Week on week', value: n(b.change_7dover7d), format: 'signedPct' },
            { label: `${label}, 30 days`, value: n(b.total30d), format: 'usdCompact' },
            { label: `${label}, 1 year`, value: n(b.total1y), format: 'usdCompact' },
            { label: 'Reporting', value: all.length, format: 'int' },
          ],
        },
        {
          kind: 'table',
          title: `Largest by ${kind}, last 24 hours`,
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Protocol or chain', maxWidth: 28 },
            { key: 'category', label: 'Category', maxWidth: 20 },
            { key: 'd1', label: '24h', format: 'usdCompact' },
            { key: 'd7', label: '7d', format: 'usdCompact' },
            { key: 'd30', label: '30d', format: 'usdCompact' },
            { key: 'y1', label: '1 year', format: 'usdCompact' },
            { key: 'wow', label: 'Week on week', format: 'signedPct' },
          ],
          rows: all.slice(0, 40).map((d, i) => ({ rank: i + 1, name: d.name, category: d.category, d1: d.d1, d7: d.d7, d30: d.d30, y1: d.y1, wow: d.wow })),
        },
      ],
      sourceUrl: kind === 'revenue' ? 'https://defillama.com/revenue' : 'https://defillama.com/fees',
      asOf: minuteStamp(ctx),
      notes: ['Fees are everything users pay, including the part passed on to liquidity providers, lenders or validators. Revenue is what the protocol or its token holders keep. Chains count transaction fees.'],
    };
  },
};

// ---------------------------------------------------------------- yields

export interface Pool {
  project: string;
  chain: string;
  symbol: string;
  tvl: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  apyMean30d: number | null;
  stablecoin: boolean;
  exposure: string;
  ilRisk: string;
  outlier: boolean;
}

/** DefiLlama yields `GET /pools`. */
export function parsePools(body: unknown): Pool[] {
  const out: Pool[] = [];
  for (const raw of list(rec(body).data)) {
    const p = rec(raw);
    const tvlUsd = n(p.tvlUsd);
    const apy = n(p.apy);
    if (!str(p.project) || tvlUsd === null || apy === null) continue;
    out.push({
      project: str(p.project),
      chain: str(p.chain),
      symbol: str(p.symbol),
      tvl: tvlUsd,
      apy,
      apyBase: n(p.apyBase),
      apyReward: n(p.apyReward),
      apyMean30d: n(p.apyMean30d),
      stablecoin: p.stablecoin === true,
      exposure: str(p.exposure),
      ilRisk: str(p.ilRisk),
      outlier: p.outlier === true,
    });
  }
  return out;
}

/** Pools worth showing: real size, a positive yield, not flagged as an outlier; highest yield first. */
export function pickPools(pools: Pool[], opts: { filter: string; chain?: string; minTvl: number }): Pool[] {
  const chain = opts.chain && opts.chain.toLowerCase() !== 'all' ? opts.chain.toLowerCase() : null;
  return pools
    .filter((p) => p.tvl >= opts.minTvl && p.apy > 0 && !p.outlier)
    .filter((p) => (chain ? p.chain.toLowerCase() === chain : true))
    .filter((p) => (opts.filter === 'stablecoins' ? p.stablecoin : opts.filter === 'single asset' ? p.exposure === 'single' && p.ilRisk === 'no' : true))
    .sort((a, b) => (opts.filter === 'largest' ? b.tvl - a.tvl : b.apy - a.apy));
}

const yields: CardDef = {
  id: 'crypto.defi-yields',
  title: 'Yields',
  source: LLAMA,
  description: 'DeFi pools by yield: stablecoin pools, single-asset pools or the largest pools, with base and reward yield and the 30-day average.',
  params: [
    { name: 'filter', label: 'Show', default: 'stablecoins', choices: ['stablecoins', 'single asset', 'all', 'largest'] },
    { name: 'chain', label: 'Chain', default: 'All', hint: 'All, Ethereum, Solana, Base, Arbitrum ...' },
    { name: 'min', label: 'Minimum size ($M)', default: '50', choices: ['10', '50', '100', '500'] },
  ],
  async run(ctx, params) {
    const filter = params.filter ?? 'stablecoins';
    const minTvl = (Number(params.min) || 50) * 1e6;
    const all = parsePools(await llama(ctx, 'https://yields.llama.fi/pools'));
    const rows = pickPools(all, { filter, chain: params.chain, minTvl });
    if (!rows.length) throw new SourceError(LLAMA, 'no pools match those filters');
    return {
      blocks: [
        {
          kind: 'table',
          title: `${filter === 'largest' ? 'Largest pools' : `Highest yields, ${filter === 'all' ? 'all pools' : filter}`}, at least $${Number(params.min) || 50}M`,
          columns: [
            { key: 'project', label: 'Protocol', maxWidth: 24 },
            { key: 'chain', label: 'Chain' },
            { key: 'symbol', label: 'Pool', maxWidth: 22 },
            { key: 'tvl', label: 'Size', format: 'usdCompact' },
            { key: 'apy', label: 'Yield', format: 'pct' },
            { key: 'apyBase', label: 'Base', format: 'pct' },
            { key: 'apyReward', label: 'Rewards', format: 'pct' },
            { key: 'apyMean30d', label: '30-day mean', format: 'pct' },
          ],
          rows: rows.slice(0, 40).map((p): Row => ({ project: p.project, chain: p.chain, symbol: p.symbol, tvl: p.tvl, apy: p.apy, apyBase: p.apyBase, apyReward: p.apyReward, apyMean30d: p.apyMean30d })),
        },
      ],
      sourceUrl: 'https://defillama.com/yields',
      asOf: minuteStamp(ctx),
      notes: [
        'Yields are annualised from recent pool income and change daily. The rewards part is paid in the protocol\'s own token and depends on its price. Pools DefiLlama flags as outliers are left out.',
        'A high yield is payment for a risk: smart contract failure, a depeg, or loss against simply holding the assets. This is not a recommendation.',
      ],
    };
  },
};

// ---------------------------------------------------------------- hacks

export interface Hack {
  t: number;
  name: string;
  amount: number | null;
  classification: string;
  technique: string;
  chain: string;
}

/** DefiLlama `GET /hacks`, newest first. */
export function parseHacks(body: unknown): Hack[] {
  const out: Hack[] = [];
  for (const raw of list(body)) {
    const h = rec(raw);
    const t = n(h.date);
    if (t === null || !str(h.name)) continue;
    out.push({ t: t * 1000, name: str(h.name), amount: n(h.amount), classification: str(h.classification), technique: str(h.technique), chain: list(h.chain).map(str).join(', ') });
  }
  return out.sort((a, b) => b.t - a.t);
}

const hacks: CardDef = {
  id: 'crypto.defi-hacks',
  title: 'Hacks and Exploits',
  source: LLAMA,
  description: 'The latest crypto hacks and exploits with the amount lost and how, the largest on record, and losses by year.',
  async run(ctx) {
    const all = parseHacks(await llama(ctx, 'https://api.llama.fi/hacks'));
    if (!all.length) throw new SourceError(LLAMA, 'no incidents returned');
    const now = ctx.now().getTime();
    const year = new Date(now).getUTCFullYear();
    const byYear = new Map<number, number>();
    for (const h of all) byYear.set(new Date(h.t).getUTCFullYear(), (byYear.get(new Date(h.t).getUTCFullYear()) ?? 0) + (h.amount ?? 0));
    const years = [...byYear.entries()].sort((a, b) => a[0] - b[0]).slice(-10);
    const since = (days: number) => all.filter((h) => h.t >= now - days * DAY);
    const cols = [
      { key: 'date', label: 'Date', format: 'date' as const },
      { key: 'name', label: 'Target', maxWidth: 26 },
      { key: 'amount', label: 'Lost', format: 'usdCompact' as const },
      { key: 'classification', label: 'Kind', maxWidth: 24 },
      { key: 'technique', label: 'How', maxWidth: 36 },
      { key: 'chain', label: 'Chain', maxWidth: 18 },
    ];
    const row = (h: Hack): Row => ({ date: h.t, name: h.name, amount: h.amount, classification: h.classification, technique: h.technique, chain: h.chain });
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Lost, last 30 days', value: sum(since(30).map((h) => h.amount)), format: 'usdCompact' },
            { label: 'Incidents, last 30 days', value: since(30).length, format: 'int' },
            { label: `Lost in ${year}`, value: byYear.get(year) ?? 0, format: 'usdCompact' },
            { label: `Incidents in ${year}`, value: all.filter((h) => new Date(h.t).getUTCFullYear() === year).length, format: 'int' },
            { label: 'Lost, all time', value: sum(all.map((h) => h.amount)), format: 'usdCompact' },
            { label: 'Incidents on record', value: all.length, format: 'int' },
          ],
        },
        {
          kind: 'chart',
          title: 'Lost to hacks by year (USD)',
          xType: 'category',
          style: 'bar',
          yFormat: 'usdCompact',
          categories: years.map((y) => String(y[0])),
          series: [{ name: 'Lost', points: years.map((y, i): [number, number] => [i, y[1]]) }],
        },
        { kind: 'table', title: 'Latest', columns: cols, rows: all.slice(0, 25).map(row) },
        { kind: 'table', title: 'Largest on record', columns: cols, rows: [...all].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, 10).map(row) },
      ],
      sourceUrl: 'https://defillama.com/hacks',
      asOf: new Date(all[0].t).toISOString().slice(0, 10),
      notes: ['Amounts are the dollar value at the time of the incident, before any funds were returned. Includes exchanges and bridges as well as DeFi protocols.'],
    };
  },
};

export const defiCards: CardDef[] = [tvl, chains, protocolsCard, categoriesCard, dexVolume, dexChains, fees, yields, hacks];
