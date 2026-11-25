/** Ethereum on chain: supply, burn and issuance, gas, staking, activity, and the layer 2 networks that settle to it. */
import { SourceError, type CardDef, type Ctx, type Row } from '../../types.js';
import { protocols } from './defi.js';
import { changeOver, list, minuteStamp, n, rec, share, str, sum } from './util.js';

export const ULTRASOUND = 'ultrasound.money';
export const BLOCKSCOUT = 'Blockscout';
export const L2BEAT = 'L2BEAT';

async function ultra(ctx: Ctx, path: string, ttl = 300): Promise<Record<string, unknown>> {
  return rec(await ctx.http.json<unknown>(`https://ultrasound.money/api/v2/fees/${path}`, { source: ULTRASOUND, ttl }));
}

// ---------------------------------------------------------------- supply, burn, issuance

export interface SupplyParts {
  /** ETH. */
  supply: number;
  /** ETH held by validators on the beacon chain. */
  staked: number;
  /** ETH ever deposited to the beacon chain. */
  deposited: number;
}

/**
 * ultrasound.money `supply-parts`. Execution balances are in wei, beacon
 * figures in gwei. Deposits left the execution layer, so supply is execution
 * balances plus validator balances minus deposits already counted.
 */
export function parseSupplyParts(body: unknown): SupplyParts | null {
  const b = rec(body);
  const exec = n(b.executionBalancesSum);
  const beacon = n(b.beaconBalancesSum);
  const deposits = n(b.beaconDepositsSum);
  if (exec === null || beacon === null || deposits === null) return null;
  return { supply: exec / 1e18 + beacon / 1e9 - deposits / 1e9, staked: beacon / 1e9, deposited: deposits / 1e9 };
}

const WINDOWS: [string, string][] = [
  ['h1', 'Last hour'],
  ['d1', 'Last day'],
  ['d7', 'Last 7 days'],
  ['d30', 'Last 30 days'],
  ['since_merge', 'Since the Merge (Sep 2022)'],
  ['since_burn', 'Since the burn began (Aug 2021)'],
];

const supplyCard: CardDef = {
  id: 'crypto.eth-supply',
  title: 'Ether Supply, Burn and Issuance',
  source: ULTRASOUND,
  description: 'Ether in existence, how much has been burned in fees and issued to validators, and whether supply is growing or shrinking at the current pace.',
  async run(ctx) {
    const [parts, burn, rates] = await Promise.all([ultra(ctx, 'supply-parts').then(parseSupplyParts), ultra(ctx, 'burn-sums'), ultra(ctx, 'gauge-rates')]);
    if (!parts) throw new SourceError(ULTRASOUND, 'no supply figures returned');
    const rate = (w: string) => rec(rates[w]);
    const eth = (v: unknown) => n(rec(v).eth);
    const growth = (w: string) => (n(rate(w).supply_growth_rate_yearly) === null ? null : (n(rate(w).supply_growth_rate_yearly) as number) * 100);
    const rows: Row[] = WINDOWS.map(([key, label]) => ({
      window: label,
      burned: eth(rec(burn[key]).sum),
      burnedUsd: n(rec(rec(burn[key]).sum).usd),
      burnRate: eth(rate(key).burn_rate_yearly),
      issuance: eth(rate(key).issuance_rate_yearly),
      growth: growth(key),
    }));
    const d7 = rate('d7');
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Ether supply', value: parts.supply, format: 'num', digits: 0 },
            { label: 'Growth, 7-day pace', value: growth('d7'), format: 'signedPct', digits: 3 },
            { label: 'Growth, 30-day pace', value: growth('d30'), format: 'signedPct', digits: 3 },
            { label: 'Issuance, ETH a year', value: eth(d7.issuance_rate_yearly), format: 'num', digits: 0 },
            { label: 'Burn, ETH a year', value: eth(d7.burn_rate_yearly), format: 'num', digits: 0 },
            { label: 'Burned, 24 hours (ETH)', value: eth(rec(burn.d1).sum), format: 'num', digits: 1 },
            { label: 'Burned since 2021 (ETH)', value: eth(rec(burn.since_burn).sum), format: 'num', digits: 0 },
            { label: 'Staked (ETH)', value: parts.staked, format: 'num', digits: 0 },
            { label: 'Share of supply staked', value: share(parts.staked, parts.supply), format: 'pct' },
            { label: 'Growth if still proof of work', value: n(d7.supply_growth_rate_yearly_pow) === null ? null : (n(d7.supply_growth_rate_yearly_pow) as number) * 100, format: 'signedPct', digits: 2 },
          ],
        },
        {
          kind: 'table',
          title: 'By window',
          columns: [
            { key: 'window', label: 'Window' },
            { key: 'burned', label: 'Burned (ETH)', format: 'num', digits: 1 },
            { key: 'burnedUsd', label: 'Burned', format: 'usdCompact' },
            { key: 'burnRate', label: 'Burn pace, ETH a year', format: 'num', digits: 0 },
            { key: 'issuance', label: 'Issuance, ETH a year', format: 'num', digits: 0 },
            { key: 'growth', label: 'Supply growth a year', format: 'signedPct', digits: 3 },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://ultrasound.money/',
      asOf: str(rec(burn.d1).timestamp).slice(0, 16) + 'Z',
      notes: ['Every transaction burns its base fee; validators are paid newly issued ether. Supply shrinks when the burn outpaces issuance, which needs busy blocks. Paces are the window\'s rate scaled to a year; the headline issuance and burn are the 7-day pace.'],
    };
  },
};

/** ultrasound.money `supply-over-time` window to an ascending [ms, ETH] series. */
export function parseSupplySeries(body: unknown, window: string): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of list(rec(body)[window])) {
    const t = Date.parse(str(rec(raw).timestamp));
    const v = n(rec(raw).supply);
    if (!Number.isNaN(t) && v !== null) out.push([t, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const SUPPLY_WINDOWS: Record<string, string> = { '1 day': 'd1', '7 days': 'd7', '30 days': 'd30', 'since the Merge': 'since_merge', 'since the burn': 'since_burn' };

const supplyHistory: CardDef = {
  id: 'crypto.eth-supply-history',
  title: 'Ether Supply History',
  source: ULTRASOUND,
  description: 'Ether supply through time: since the Merge, since the fee burn began, or over the last day, week or month.',
  params: [{ name: 'window', label: 'Window', default: 'since the Merge', choices: Object.keys(SUPPLY_WINDOWS) }],
  async run(ctx, params) {
    const label = SUPPLY_WINDOWS[params.window] ? params.window : 'since the Merge';
    const pts = parseSupplySeries(await ultra(ctx, 'supply-over-time', 900), SUPPLY_WINDOWS[label]);
    if (pts.length < 2) throw new SourceError(ULTRASOUND, 'no supply history returned');
    const first = pts[0];
    const last = pts[pts.length - 1];
    const years = (last[0] - first[0]) / (365 * 86_400_000);
    const peak = pts.reduce((m, p) => (p[1] > m[1] ? p : m), pts[0]);
    const low = pts.reduce((m, p) => (p[1] < m[1] ? p : m), pts[0]);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Supply now (ETH)', value: last[1], format: 'num', digits: 0 },
            { label: `Change ${label} (ETH)`, value: last[1] - first[1], format: 'signed', digits: 0 },
            { label: 'Change, percent', value: (last[1] / first[1] - 1) * 100, format: 'signedPct', digits: 3 },
            { label: 'Annualised', value: years > 0.02 ? ((last[1] / first[1]) ** (1 / years) - 1) * 100 : null, format: 'signedPct', digits: 3 },
            { label: 'Highest in window (ETH)', value: peak[1], format: 'num', digits: 0 },
            { label: 'Highest on', value: new Date(peak[0]).toISOString().slice(0, 10) },
            { label: 'Lowest in window (ETH)', value: low[1], format: 'num', digits: 0 },
            { label: 'Lowest on', value: new Date(low[0]).toISOString().slice(0, 10) },
          ],
        },
        { kind: 'chart', title: `Ether supply, ${label}`, xType: 'time', yFormat: 'num', yDigits: 0, series: [{ name: 'Supply', points: pts }] },
      ],
      sourceUrl: 'https://ultrasound.money/',
      asOf: new Date(last[0]).toISOString().slice(0, 16) + 'Z',
    };
  },
};

// ---------------------------------------------------------------- gas

const GWEI = 1e9;

const gas: CardDef = {
  id: 'crypto.eth-gas',
  title: 'Gas Prices',
  source: BLOCKSCOUT,
  description: 'Ethereum gas prices now (slow, average, fast) with the dollar cost of common transactions, and the base fee over the last hour, day, week and month.',
  async run(ctx) {
    const [stats, base] = await Promise.allSettled([ctx.http.json<unknown>('https://eth.blockscout.com/api/v2/stats', { source: BLOCKSCOUT, ttl: 30 }).then(rec), ultra(ctx, 'base-fee-per-gas-stats', 120)]);
    if (stats.status === 'rejected' && base.status === 'rejected') throw stats.reason;
    const s = stats.status === 'fulfilled' ? stats.value : {};
    const b = base.status === 'fulfilled' ? base.value : {};
    const prices = rec(s.gas_prices);
    const eth = n(s.coin_price);
    const cost = (gwei: number | null, units: number) => (gwei === null || eth === null ? null : (gwei * units * eth) / GWEI);
    const avg = n(prices.average);
    const windows = rec(b.base_fee_per_gas_stats);
    const rows: Row[] = [
      ['m5', 'Last 5 minutes'],
      ['h1', 'Last hour'],
      ['d1', 'Last day'],
      ['d7', 'Last 7 days'],
      ['d30', 'Last 30 days'],
    ]
      .map(([k, label]) => {
        const w = rec(windows[k]);
        const g = (v: unknown) => (n(v) === null ? null : (n(v) as number) / GWEI);
        return { window: label, min: g(w.min), average: g(w.average), max: g(w.max), transfer: cost(g(w.average), 21_000) };
      })
      .filter((r) => r.average !== null);
    if (avg === null && !rows.length) throw new SourceError(BLOCKSCOUT, 'no gas prices returned');
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Slow (gwei)', value: n(prices.slow), format: 'num', digits: 3 },
            { label: 'Average (gwei)', value: avg, format: 'num', digits: 3 },
            { label: 'Fast (gwei)', value: n(prices.fast), format: 'num', digits: 3 },
            { label: 'Send ether (21,000 gas)', value: cost(avg, 21_000), format: 'usd', digits: 4 },
            { label: 'Send token (65,000 gas)', value: cost(avg, 65_000), format: 'usd', digits: 4 },
            { label: 'DEX swap (180,000 gas)', value: cost(avg, 180_000), format: 'usd', digits: 3 },
            { label: 'Blocks full, today', value: n(s.network_utilization_percentage), format: 'pct' },
            { label: 'Break-even base fee (gwei)', value: n(b.barrier), format: 'num', digits: 2 },
            { label: 'Ether price', value: eth, format: 'usd' },
          ],
        },
        ...(rows.length
          ? [
              {
                kind: 'table' as const,
                title: 'Base fee by window (gwei)',
                columns: [
                  { key: 'window', label: 'Window' },
                  { key: 'min', label: 'Lowest', format: 'num' as const, digits: 3 },
                  { key: 'average', label: 'Average', format: 'num' as const, digits: 3 },
                  { key: 'max', label: 'Highest', format: 'num' as const, digits: 2 },
                  { key: 'transfer', label: 'Ether transfer at the average', format: 'usd' as const, digits: 4 },
                ],
                rows,
              },
            ]
          : []),
      ],
      source: [stats.status === 'fulfilled' ? BLOCKSCOUT : '', base.status === 'fulfilled' ? ULTRASOUND : ''].filter(Boolean).join(', '),
      sourceUrl: 'https://eth.blockscout.com/gas-tracker',
      asOf: str(s.gas_price_updated_at).slice(0, 19) ? str(s.gas_price_updated_at).slice(0, 19) + 'Z' : minuteStamp(ctx),
      notes: ['Gas prices are in gwei (a billionth of an ether) per unit of gas, on Ethereum mainnet. The dollar costs use typical gas amounts; a real transaction can use more. The break-even base fee is where the burn equals new issuance; above it, ether supply shrinks.'],
    };
  },
};

// ---------------------------------------------------------------- staking

const staking: CardDef = {
  id: 'crypto.eth-staking',
  title: 'Staking',
  source: ULTRASOUND,
  description: 'Ether staked with validators and its share of supply, the yield from issuance, and the liquid staking protocols holding the most.',
  async run(ctx) {
    const [parts, rates, burn, lst] = await Promise.all([
      ultra(ctx, 'supply-parts').then(parseSupplyParts),
      ultra(ctx, 'gauge-rates'),
      ultra(ctx, 'burn-sums'),
      protocols(ctx)
        .then((all) => all.filter((p) => /^Liquid (Re)?Staking$/i.test(p.category) && (p.ethereumTvl ?? 0) > 0).sort((a, b) => (b.ethereumTvl ?? 0) - (a.ethereumTvl ?? 0)))
        .catch(() => []),
    ]);
    if (!parts) throw new SourceError(ULTRASOUND, 'no staking figures returned');
    const issuance = n(rec(rec(rates.d7).issuance_rate_yearly).eth);
    const day = rec(rec(burn.d1).sum);
    const price = n(day.eth) && n(day.usd) ? (n(day.usd) as number) / (n(day.eth) as number) : null;
    const stakedUsd = price === null ? null : parts.staked * price;
    const liquid = lst.filter((p) => p.category === 'Liquid Staking');
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Staked (ETH)', value: parts.staked, format: 'num', digits: 0 },
            { label: 'Staked', value: stakedUsd, format: 'usdCompact' },
            { label: 'Share of supply staked', value: share(parts.staked, parts.supply), format: 'pct' },
            { label: 'Ever deposited (ETH)', value: parts.deposited, format: 'num', digits: 0 },
            { label: 'Issuance, ETH a year', value: issuance, format: 'num', digits: 0 },
            { label: 'Yield from issuance', value: issuance === null ? null : (issuance / parts.staked) * 100, format: 'pct', digits: 2 },
            { label: 'In liquid staking', value: stakedUsd ? share(sum(liquid.map((p) => p.ethereumTvl)), stakedUsd) : null, format: 'pct' },
          ],
        },
        ...(lst.length
          ? [
              {
                kind: 'table' as const,
                title: 'Liquid staking and restaking protocols on Ethereum',
                columns: [
                  { key: 'name', label: 'Protocol', maxWidth: 28 },
                  { key: 'category', label: 'Kind' },
                  { key: 'tvl', label: 'On Ethereum', format: 'usdCompact' as const },
                  { key: 'share', label: 'Share of staked ether', format: 'pct' as const },
                  { key: 'chg7d', label: '7d', format: 'signedPct' as const },
                ],
                rows: lst.slice(0, 20).map((p) => ({ name: p.name, category: p.category, tvl: p.ethereumTvl, share: stakedUsd ? share(p.ethereumTvl, stakedUsd) : null, chg7d: p.chg7d })),
              },
            ]
          : []),
      ],
      source: lst.length ? `${ULTRASOUND}, DefiLlama` : ULTRASOUND,
      sourceUrl: 'https://ultrasound.money/',
      asOf: minuteStamp(ctx),
      notes: [
        'Staked ether is the sum of validator balances on the beacon chain. The yield shown is new issuance only; validators also earn priority fees and MEV, which vary block to block.',
        'Restaking protocols reuse ether that is already staked, so their rows overlap the liquid staking rows and are left out of the liquid staking share. Shares use the day\'s average ether price.',
      ],
    };
  },
};

// ---------------------------------------------------------------- activity

const activity: CardDef = {
  id: 'crypto.eth-activity',
  title: 'Network Activity',
  source: BLOCKSCOUT,
  description: 'Ethereum mainnet transactions per day over the last month, with totals for addresses and transactions and how full blocks are.',
  async run(ctx) {
    const [chart, stats] = await Promise.all([
      ctx.http.json<unknown>('https://eth.blockscout.com/api/v2/stats/charts/transactions', { source: BLOCKSCOUT, ttl: 1800 }),
      ctx.http.json<unknown>('https://eth.blockscout.com/api/v2/stats', { source: BLOCKSCOUT, ttl: 30 }).then(rec),
    ]);
    const pts: [number, number][] = [];
    for (const raw of list(rec(chart).chart_data)) {
      const t = Date.parse(str(rec(raw).date));
      const v = n(rec(raw).transactions_count);
      if (!Number.isNaN(t) && v !== null) pts.push([t, v]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) throw new SourceError(BLOCKSCOUT, 'no transaction history returned');
    const values = pts.map((p) => p[1]);
    const last = pts[pts.length - 1];
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Transactions, last day', value: last[1], format: 'int' },
            { label: 'Per second', value: last[1] / 86_400, format: 'num', digits: 1 },
            { label: '30-day average', value: sum(values) / values.length, format: 'int' },
            { label: '7 days', value: changeOver(pts, 7), format: 'signedPct' },
            { label: 'Blocks full, today', value: n(stats.network_utilization_percentage), format: 'pct' },
            { label: 'Block time (seconds)', value: n(stats.average_block_time) === null ? null : (n(stats.average_block_time) as number) / 1000, format: 'num', digits: 1 },
            { label: 'Transactions, all time', value: n(stats.total_transactions), format: 'compact' },
            { label: 'Addresses, all time', value: n(stats.total_addresses), format: 'compact' },
          ],
        },
        { kind: 'chart', title: 'Ethereum transactions per day', xType: 'time', yFormat: 'int', series: [{ name: 'Transactions', points: pts }] },
      ],
      sourceUrl: 'https://eth.blockscout.com/stats',
      asOf: new Date(last[0]).toISOString().slice(0, 10),
      notes: ['Mainnet only. Most Ethereum activity now happens on layer 2 networks; see the Layer 2 tab.'],
    };
  },
};

// ---------------------------------------------------------------- layer 2 (L2BEAT)

const L2_RANGE: Record<string, string> = { '1M': '30d', '3M': '90d', '6M': '180d', '1Y': '1y', MAX: 'max' };

async function l2beat(ctx: Ctx, path: string, ttl = 1800): Promise<Record<string, unknown>> {
  const body = rec(await ctx.http.json<unknown>(`https://l2beat.com/api/scaling/${path}`, { source: L2BEAT, ttl, timeoutMs: 30_000 }));
  return rec(body.data ?? body);
}

/** An L2BEAT chart (`{types: [...], data: [[...]]}`) to rows keyed by the type names. Timestamps become ms. */
export function parseL2Chart(chart: unknown): Record<string, number>[] {
  const c = rec(chart);
  const types = list(c.types).map(str);
  const out: Record<string, number>[] = [];
  for (const raw of list(c.data)) {
    const row: Record<string, number> = {};
    list(raw).forEach((v, i) => {
      const x = n(v);
      if (types[i] && x !== null) row[types[i]] = types[i] === 'timestamp' ? x * 1000 : x;
    });
    if (row.timestamp) out.push(row);
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

const l2Tvs: CardDef = {
  id: 'crypto.l2-tvs',
  title: 'Layer 2: Value Secured',
  source: L2BEAT,
  description: 'The value held on Ethereum layer 2 networks through time, split into bridged from Ethereum, bridged by third parties, and issued natively.',
  params: [{ name: 'range', label: 'Range', default: '1Y', choices: Object.keys(L2_RANGE) }],
  async run(ctx, params) {
    const range = L2_RANGE[(params.range ?? '1Y').toUpperCase()] ?? '1y';
    const data = await l2beat(ctx, `tvs?range=${range}`);
    const rows = parseL2Chart(data.chart);
    if (rows.length < 2) throw new SourceError(L2BEAT, 'no value-secured history returned');
    const total = rows.map((r): [number, number] => [r.timestamp, (r.native ?? 0) + (r.canonical ?? 0) + (r.external ?? 0)]);
    const last = rows[rows.length - 1];
    const now = total[total.length - 1][1];
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Value secured', value: n(data.usdValue) ?? now, format: 'usdCompact' },
            { label: 'In ether terms (ETH)', value: n(data.ethValue), format: 'compact' },
            { label: '7 days', value: changeOver(total, 7), format: 'signedPct' },
            { label: '30 days', value: changeOver(total, 30), format: 'signedPct' },
            { label: 'Bridged from Ethereum', value: share(last.canonical, now), format: 'pct' },
            { label: 'Bridged by third parties', value: share(last.external, now), format: 'pct' },
            { label: 'Issued natively', value: share(last.native, now), format: 'pct' },
          ],
        },
        {
          kind: 'chart',
          title: 'Layer 2 value secured (USD)',
          xType: 'time',
          yFormat: 'usdCompact',
          series: [
            { name: 'Total', points: total },
            { name: 'Bridged from Ethereum', points: rows.map((r): [number, number] => [r.timestamp, r.canonical ?? 0]) },
            { name: 'Third-party bridges', points: rows.map((r): [number, number] => [r.timestamp, r.external ?? 0]) },
            { name: 'Native', points: rows.map((r): [number, number] => [r.timestamp, r.native ?? 0]) },
          ],
        },
      ],
      sourceUrl: 'https://l2beat.com/scaling/tvs',
      asOf: new Date(last.timestamp).toISOString().slice(0, 16) + 'Z',
      notes: ['"Value secured" is L2BEAT\'s measure of assets on layer 2 networks. Only the part bridged through a network\'s own Ethereum bridge inherits Ethereum\'s security; third-party bridged and natively issued tokens carry their issuer\'s risk.'],
    };
  },
};

export interface L2Project {
  name: string;
  category: string;
  stage: string;
  total: number;
  ether: number | null;
  stablecoin: number | null;
  change7d: number | null;
}

/** L2BEAT `scaling/summary` projects, largest first. Archived projects are dropped. */
export function parseL2Projects(body: unknown): L2Project[] {
  const out: L2Project[] = [];
  for (const raw of Object.values(rec(rec(body).projects))) {
    const p = rec(raw);
    const tvs = rec(p.tvs);
    const b = rec(tvs.breakdown);
    const total = n(b.total);
    if (!str(p.name) || p.isArchived === true || total === null || !(total > 0)) continue;
    const c = n(tvs.change7d);
    out.push({ name: str(p.name), category: str(p.category), stage: str(p.stage), total, ether: n(b.ether), stablecoin: n(b.stablecoin), change7d: c === null ? null : c * 100 });
  }
  return out.sort((a, b) => b.total - a.total);
}

const l2Projects: CardDef = {
  id: 'crypto.l2-projects',
  title: 'Layer 2 Networks',
  source: L2BEAT,
  description: 'Ethereum layer 2 networks by value secured: type, decentralization stage, weekly change, and how much is ether and stablecoins.',
  async run(ctx) {
    const all = parseL2Projects(await l2beat(ctx, 'summary'));
    if (!all.length) throw new SourceError(L2BEAT, 'no networks returned');
    const total = sum(all.map((p) => p.total));
    const stage = (s: string) => sum(all.filter((p) => p.stage === s).map((p) => p.total));
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Value secured', value: total, format: 'usdCompact' },
            { label: 'Networks', value: all.length, format: 'int' },
            { label: `${all[0].name} share`, value: share(all[0].total, total), format: 'pct' },
            { label: 'Top 3 networks', value: share(sum(all.slice(0, 3).map((p) => p.total)), total), format: 'pct' },
            { label: 'On Stage 1 or 2 networks', value: share(stage('Stage 1') + stage('Stage 2'), total), format: 'pct' },
            { label: 'Stablecoins', value: share(sum(all.map((p) => p.stablecoin)), total), format: 'pct' },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Network', maxWidth: 24 },
            { key: 'category', label: 'Type', maxWidth: 18 },
            { key: 'stage', label: 'Stage' },
            { key: 'total', label: 'Value secured', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'change7d', label: '7d', format: 'signedPct' },
            { key: 'ether', label: 'Ether', format: 'usdCompact' },
            { key: 'stablecoin', label: 'Stablecoins', format: 'usdCompact' },
          ],
          rows: all.slice(0, 35).map((p, i) => ({ rank: i + 1, ...p, share: share(p.total, total) })),
        },
      ],
      sourceUrl: 'https://l2beat.com/scaling/summary',
      asOf: minuteStamp(ctx),
      notes: ['Stages are L2BEAT\'s rating of how far a rollup has moved from operator control to trustless proofs: Stage 0 relies on its operators, Stage 2 on code alone. Networks L2BEAT has not rated show no stage. The table sums every listed network, including those L2BEAT classes as Other, so its total differs from the headline on the value-secured card.'],
    };
  },
};

const l2Activity: CardDef = {
  id: 'crypto.l2-activity',
  title: 'Layer 2: Activity',
  source: L2BEAT,
  description: 'Transactions and user operations per day across Ethereum layer 2 networks.',
  params: [{ name: 'range', label: 'Range', default: '1Y', choices: Object.keys(L2_RANGE) }],
  async run(ctx, params) {
    const range = L2_RANGE[(params.range ?? '1Y').toUpperCase()] ?? '1y';
    const rows = parseL2Chart((await l2beat(ctx, `activity?range=${range}`)).chart);
    if (rows.length < 2) throw new SourceError(L2BEAT, 'no activity history returned');
    const tx = rows.map((r): [number, number] => [r.timestamp, r.count ?? 0]);
    const uops = rows.filter((r) => r.uopsCount !== undefined).map((r): [number, number] => [r.timestamp, r.uopsCount]);
    const last = rows[rows.length - 1];
    const last30 = tx.slice(-30).map((p) => p[1]);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Transactions, latest day', value: last.count, format: 'compact' },
            { label: 'Per second', value: (last.count ?? 0) / 86_400, format: 'num', digits: 0 },
            { label: 'User operations', value: last.uopsCount, format: 'compact' },
            { label: '30-day average', value: sum(last30) / last30.length, format: 'compact' },
            { label: '30 days', value: changeOver(tx, 30), format: 'signedPct' },
            { label: 'Busiest day in range', value: Math.max(...tx.map((p) => p[1])), format: 'compact' },
          ],
        },
        {
          kind: 'chart',
          title: 'Layer 2 activity per day',
          xType: 'time',
          yFormat: 'compact',
          series: [{ name: 'Transactions', points: tx }, ...(uops.length ? [{ name: 'User operations', points: uops }] : [])],
        },
      ],
      sourceUrl: 'https://l2beat.com/scaling/activity',
      asOf: new Date(last.timestamp).toISOString().slice(0, 10),
      notes: ['Summed across the layer 2 networks L2BEAT tracks. A user operation is one user action; a bundled transaction can carry many, so operations are the better count of use.'],
    };
  },
};

export const ethereumCards: CardDef[] = [supplyCard, supplyHistory, gas, staking, activity, l2Tvs, l2Projects, l2Activity];
