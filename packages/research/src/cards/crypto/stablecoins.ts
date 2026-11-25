/** Stablecoins from DefiLlama: supply by coin and by chain, peg deviations and supply through time. */
import { SourceError, type CardDef, type Row } from '../../types.js';
import { LLAMA, llama, unknownChain } from './defi.js';
import { RANGE_CHOICES, changeOver, clip, list, minuteStamp, n, rec, share, str, sum } from './util.js';

export interface Stablecoin {
  name: string;
  symbol: string;
  /** peggedUSD, peggedEUR ... */
  pegType: string;
  mechanism: string;
  /** Units in circulation; for dollar pegs this is also the dollar value at par. */
  supply: number;
  prevDay: number | null;
  prevWeek: number | null;
  prevMonth: number | null;
  price: number | null;
  chains: number;
}

/** DefiLlama `GET /stablecoins?includePrices=true`, largest first. */
export function parseStablecoins(body: unknown): Stablecoin[] {
  const out: Stablecoin[] = [];
  for (const raw of list(rec(body).peggedAssets)) {
    const a = rec(raw);
    const peg = str(a.pegType);
    const supply = n(rec(a.circulating)[peg]);
    if (!str(a.symbol) || supply === null || !(supply > 0)) continue;
    out.push({
      name: str(a.name),
      symbol: str(a.symbol),
      pegType: peg,
      mechanism: str(a.pegMechanism),
      supply,
      prevDay: n(rec(a.circulatingPrevDay)[peg]),
      prevWeek: n(rec(a.circulatingPrevWeek)[peg]),
      prevMonth: n(rec(a.circulatingPrevMonth)[peg]),
      price: n(a.price),
      chains: list(a.chains).length,
    });
  }
  return out.sort((a, b) => b.supply * (b.price ?? 1) - a.supply * (a.price ?? 1));
}

const chg = (now: number, then: number | null) => (then && then > 0 ? (now / then - 1) * 100 : null);

async function stablecoins(ctx: Parameters<typeof llama>[0]): Promise<Stablecoin[]> {
  const all = parseStablecoins(await llama(ctx, 'https://stablecoins.llama.fi/stablecoins?includePrices=true', 1800));
  if (!all.length) throw new SourceError(LLAMA, 'no stablecoins returned');
  return all;
}

const supply: CardDef = {
  id: 'crypto.stablecoin-supply',
  title: 'Stablecoin Supply',
  source: LLAMA,
  description: 'Dollar stablecoins by supply: change over a day, a week and a month, market share, price, backing type and how many chains each is on.',
  async run(ctx) {
    const usd = (await stablecoins(ctx)).filter((s) => s.pegType === 'peggedUSD');
    const total = sum(usd.map((s) => s.supply));
    const month = sum(usd.map((s) => s.prevMonth));
    const week = sum(usd.map((s) => s.prevWeek));
    const by = new Map<string, number>();
    for (const s of usd) by.set(s.mechanism || 'other', (by.get(s.mechanism || 'other') ?? 0) + s.supply);
    const find = (sym: string) => usd.find((s) => s.symbol === sym)?.supply ?? null;
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Outstanding', value: total, format: 'usdCompact' },
            { label: 'Net issuance, 7 days', value: total - week, format: 'usdCompact' },
            { label: '7 days', value: chg(total, week), format: 'signedPct' },
            { label: 'Net issuance, 30 days', value: total - month, format: 'usdCompact' },
            { label: '30 days', value: chg(total, month), format: 'signedPct' },
            { label: 'USDT share', value: share(find('USDT'), total), format: 'pct' },
            { label: 'USDC share', value: share(find('USDC'), total), format: 'pct' },
            { label: 'Stablecoins tracked', value: usd.length, format: 'int' },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'name', label: 'Name', maxWidth: 24 },
            { key: 'mechanism', label: 'Backing', maxWidth: 16 },
            { key: 'supply', label: 'Supply', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'd1', label: '1d', format: 'signedPct' },
            { key: 'd7', label: '7d', format: 'signedPct' },
            { key: 'd30', label: '30d', format: 'signedPct' },
            { key: 'price', label: 'Price', format: 'usd', digits: 4 },
            { key: 'chains', label: 'Chains', format: 'int' },
          ],
          rows: usd.slice(0, 30).map((s, i) => ({ rank: i + 1, symbol: s.symbol, name: s.name, mechanism: s.mechanism, supply: s.supply, share: share(s.supply, total), d1: chg(s.supply, s.prevDay), d7: chg(s.supply, s.prevWeek), d30: chg(s.supply, s.prevMonth), price: s.price, chains: s.chains })),
        },
        {
          kind: 'table',
          title: 'By backing',
          columns: [
            { key: 'mechanism', label: 'Backing' },
            { key: 'supply', label: 'Supply', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
          ],
          rows: [...by.entries()].sort((a, b) => b[1] - a[1]).map(([mechanism, v]) => ({ mechanism, supply: v, share: share(v, total) })),
        },
      ],
      sourceUrl: 'https://defillama.com/stablecoins',
      asOf: minuteStamp(ctx),
      notes: ['Dollar-pegged tokens only. Supply is tokens in circulation, counted at one dollar each. Net issuance is the change in that supply: new tokens minted less tokens redeemed.'],
    };
  },
};

/** Dollar stablecoins of real size, furthest from one dollar first. */
export function pegRows(coins: Stablecoin[], minSupply: number): Row[] {
  return coins
    .filter((s) => s.pegType === 'peggedUSD' && s.price !== null && s.supply >= minSupply)
    .map((s) => ({ symbol: s.symbol, name: s.name, mechanism: s.mechanism, price: s.price, bp: ((s.price as number) - 1) * 10_000, supply: s.supply }))
    .sort((a, b) => Math.abs(b.bp) - Math.abs(a.bp));
}

const pegs: CardDef = {
  id: 'crypto.stablecoin-pegs',
  title: 'Peg Deviations',
  source: LLAMA,
  description: 'How far each sizeable dollar stablecoin trades from one dollar, furthest first.',
  params: [{ name: 'min', label: 'Minimum supply ($M)', default: '100', choices: ['20', '100', '500', '1000'] }],
  async run(ctx, params) {
    const min = (Number(params.min) || 100) * 1e6;
    const rows = pegRows(await stablecoins(ctx), min);
    if (!rows.length) throw new SourceError(LLAMA, 'no priced stablecoins of that size');
    const off = rows.filter((r) => Math.abs(r.bp as number) >= 50);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Stablecoins checked', value: rows.length, format: 'int' },
            { label: 'Over 0.5% off the peg', value: off.length, format: 'int' },
            { label: 'Their supply', value: sum(off.map((r) => r.supply as number)), format: 'usdCompact' },
            { label: 'Furthest', value: `${rows[0].symbol} at $${(rows[0].price as number).toFixed(4)}` },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'symbol', label: 'Symbol' },
            { key: 'name', label: 'Name', maxWidth: 26 },
            { key: 'mechanism', label: 'Backing', maxWidth: 16 },
            { key: 'price', label: 'Price', format: 'usd', digits: 4 },
            { key: 'bp', label: 'From $1', format: 'bp' },
            { key: 'supply', label: 'Supply', format: 'usdCompact' },
          ],
          rows: rows.slice(0, 40),
        },
      ],
      sourceUrl: 'https://defillama.com/stablecoins',
      asOf: minuteStamp(ctx),
      notes: ['Prices are DefiLlama\'s aggregate, refreshed here every 30 minutes; a thinly traded coin can show a stale or noisy price. Yield-bearing dollar tokens are meant to trade above one dollar, so a premium on those is not a broken peg.'],
    };
  },
};

export interface StableChain {
  name: string;
  usd: number;
}

/** DefiLlama `GET /stablecoinchains`, largest first. */
export function parseStableChains(body: unknown): StableChain[] {
  const out: StableChain[] = [];
  for (const raw of list(body)) {
    const c = rec(raw);
    const usd = n(rec(c.totalCirculatingUSD).peggedUSD);
    if (str(c.name) && usd !== null && usd > 0) out.push({ name: str(c.name), usd });
  }
  return out.sort((a, b) => b.usd - a.usd);
}

const byChain: CardDef = {
  id: 'crypto.stablecoin-chains',
  title: 'Stablecoins by Chain',
  source: LLAMA,
  description: 'Which blockchains hold the dollar stablecoin supply, with each chain\'s share.',
  async run(ctx) {
    const all = parseStableChains(await llama(ctx, 'https://stablecoins.llama.fi/stablecoinchains', 1800));
    if (!all.length) throw new SourceError(LLAMA, 'no chains returned');
    const total = sum(all.map((c) => c.usd));
    const top = all.slice(0, 12);
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Dollar stablecoins by chain (USD)',
          xType: 'category',
          style: 'bar',
          yFormat: 'usdCompact',
          categories: top.map((c) => c.name),
          series: [{ name: 'Supply', points: top.map((c, i): [number, number] => [i, c.usd]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Chain' },
            { key: 'usd', label: 'Stablecoins', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
          ],
          rows: all.slice(0, 30).map((c, i) => ({ rank: i + 1, ...c, share: share(c.usd, total) })),
        },
      ],
      sourceUrl: 'https://defillama.com/stablecoins/chains',
      asOf: minuteStamp(ctx),
      notes: ['Dollar-pegged tokens only, valued at their market price. Tokens bridged to another chain are counted on the chain they sit on.'],
    };
  },
};

/** DefiLlama `GET /stablecoincharts/{all|chain}` to an ascending [ms, dollars] series. */
export function parseStableChart(body: unknown): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of list(body)) {
    const p = rec(raw);
    const t = n(p.date);
    const v = n(rec(p.totalCirculatingUSD).peggedUSD);
    if (t !== null && v !== null && v > 0) out.push([t * 1000, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const history: CardDef = {
  id: 'crypto.stablecoin-history',
  title: 'Stablecoin Supply History',
  source: LLAMA,
  description: 'Dollar stablecoins outstanding through time, for all chains or one chain.',
  params: [
    { name: 'chain', label: 'Chain', default: 'All', hint: 'All, Ethereum, Tron, Solana, BSC, Base ...' },
    { name: 'range', label: 'Range', default: '2Y', choices: RANGE_CHOICES },
  ],
  async run(ctx, params) {
    const chain = (params.chain ?? 'All').trim();
    const all = !chain || chain.toLowerCase() === 'all';
    const pts = parseStableChart(await llama(ctx, `https://stablecoins.llama.fi/stablecoincharts/${all ? 'all' : encodeURIComponent(chain)}`).catch(unknownChain(chain)));
    if (pts.length < 2) throw new SourceError(LLAMA, `no stablecoin history for "${chain}"`);
    const last = pts[pts.length - 1];
    const peak = pts.reduce((m, p) => (p[1] > m[1] ? p : m), pts[0]);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: all ? 'Outstanding, all chains' : `Outstanding on ${chain}`, value: last[1], format: 'usdCompact' },
            { label: '7 days', value: changeOver(pts, 7), format: 'signedPct' },
            { label: '30 days', value: changeOver(pts, 30), format: 'signedPct' },
            { label: '90 days', value: changeOver(pts, 90), format: 'signedPct' },
            { label: '1 year', value: changeOver(pts, 365), format: 'signedPct' },
            { label: 'Record', value: peak[1], format: 'usdCompact' },
            { label: 'Record set', value: new Date(peak[0]).toISOString().slice(0, 10) },
          ],
        },
        { kind: 'chart', title: `Dollar stablecoins outstanding${all ? '' : ` on ${chain}`}`, xType: 'time', yFormat: 'usdCompact', series: [{ name: 'Supply', points: clip(pts, params.range, '2Y') }] },
      ],
      sourceUrl: all ? 'https://defillama.com/stablecoins' : `https://defillama.com/stablecoins/${encodeURIComponent(chain)}`,
      asOf: new Date(last[0]).toISOString().slice(0, 10),
      notes: ['Rising supply means more dollars have moved on chain than left; it is often read as buying power waiting on the sidelines, though much of it is used for payments and as collateral.'],
    };
  },
};

export const stablecoinCards: CardDef[] = [supply, pegs, byChain, history];
