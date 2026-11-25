/** Bitcoin on chain: mempool and fees, blocks, hashrate, difficulty, halving and mining pools (mempool.space), Lightning (1ML) and network activity (Blockchain.com). */
import { SourceError, type CardDef, type Ctx, type Row } from '../../types.js';
import { DAY, RANGE_CHOICES, changeOver, clip, list, minuteStamp, n, rec, share, str, sum } from './util.js';

export const MEMPOOL = 'mempool.space';
const BASE = 'https://mempool.space/api';
const SATS = 1e8;

async function mempool<T = unknown>(ctx: Ctx, path: string, ttl = 60): Promise<T> {
  return ctx.http.json<T>(`${BASE}${path}`, { source: MEMPOOL, ttl });
}

// ---------------------------------------------------------------- supply schedule

export const HALVING_INTERVAL = 210_000;

/** Block subsidy in BTC at a height. */
export function subsidyAt(height: number): number {
  const era = Math.floor(height / HALVING_INTERVAL);
  return era >= 33 ? 0 : 50 / 2 ** era;
}

/** Bitcoin issued once the block at `height` is mined (the schedule; ignores the handful of unclaimed rewards). */
export function supplyAt(height: number): number {
  let left = height + 1;
  let total = 0;
  for (let era = 0; left > 0 && era < 33; era++) {
    const blocks = Math.min(left, HALVING_INTERVAL);
    total += blocks * (50 / 2 ** era);
    left -= blocks;
  }
  return total;
}

export function nextHalving(height: number): { height: number; blocksLeft: number; subsidyAfter: number } {
  const next = (Math.floor(height / HALVING_INTERVAL) + 1) * HALVING_INTERVAL;
  return { height: next, blocksLeft: next - height, subsidyAfter: subsidyAt(next) };
}

const PAST_HALVINGS: Row[] = [
  { event: 'Launch', date: '2009-01-03', height: 0, subsidy: 50 },
  { event: 'First halving', date: '2012-11-28', height: 210_000, subsidy: 25 },
  { event: 'Second halving', date: '2016-07-09', height: 420_000, subsidy: 12.5 },
  { event: 'Third halving', date: '2020-05-11', height: 630_000, subsidy: 6.25 },
  { event: 'Fourth halving', date: '2024-04-20', height: 840_000, subsidy: 3.125 },
];

const halving: CardDef = {
  id: 'crypto.btc-halving',
  title: 'Halving Countdown and Supply',
  source: MEMPOOL,
  description: 'Blocks and estimated time to the next bitcoin halving, the block reward before and after, coins issued so far and the current inflation rate.',
  async run(ctx) {
    const [tip, da] = await Promise.all([mempool<unknown>(ctx, '/blocks/tip/height', 60), mempool<unknown>(ctx, '/v1/difficulty-adjustment', 300).then(rec)]);
    const height = n(tip);
    if (height === null || !(height > 0)) throw new SourceError(MEMPOOL, 'no chain height returned');
    const next = nextHalving(height);
    const blockMs = n(da.timeAvg) ?? 600_000;
    const now = ctx.now().getTime();
    const atTarget = now + next.blocksLeft * 600_000;
    const atPace = now + next.blocksLeft * blockMs;
    const issued = supplyAt(height);
    const subsidy = subsidyAt(height);
    const perDay = subsidy * (DAY / blockMs);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Block height', value: height, format: 'int' },
            { label: 'Next halving at block', value: next.height, format: 'int' },
            { label: 'Blocks to go', value: next.blocksLeft, format: 'int' },
            { label: 'Date at 10-minute blocks', value: atTarget, format: 'date' },
            { label: 'Date at current pace', value: atPace, format: 'date' },
            { label: 'Days to go', value: (atTarget - now) / DAY, format: 'num', digits: 0 },
            { label: 'This era complete', value: ((HALVING_INTERVAL - next.blocksLeft) / HALVING_INTERVAL) * 100, format: 'pct' },
            { label: 'Block reward now (BTC)', value: subsidy, format: 'num', digits: 4 },
            { label: 'Block reward after (BTC)', value: next.subsidyAfter, format: 'num', digits: 4 },
            { label: 'Issued so far (BTC)', value: issued, format: 'num', digits: 0 },
            { label: 'Share of 21 million', value: (issued / 21e6) * 100, format: 'pct' },
            { label: 'Left to issue (BTC)', value: 21e6 - issued, format: 'num', digits: 0 },
            { label: 'New coins per day (BTC)', value: perDay, format: 'num', digits: 0 },
            { label: 'Supply growth a year', value: ((perDay * 365) / issued) * 100, format: 'pct' },
          ],
        },
        {
          kind: 'table',
          title: 'Reward schedule',
          columns: [
            { key: 'event', label: 'Event' },
            { key: 'date', label: 'Date' },
            { key: 'height', label: 'Block', format: 'int' },
            { key: 'subsidy', label: 'Reward (BTC)', format: 'num', digits: 4 },
          ],
          rows: [...PAST_HALVINGS, { event: 'Next halving', date: `about ${new Date(atTarget).toISOString().slice(0, 10)}`, height: next.height, subsidy: next.subsidyAfter }],
        },
      ],
      sourceUrl: 'https://mempool.space/',
      asOf: minuteStamp(ctx),
      notes: ['The reward halves every 210,000 blocks. The dates are estimates: one assumes ten-minute blocks, the other the average block time of the current difficulty period. Issued coins follow the schedule and ignore the few rewards miners never claimed.'],
    };
  },
};

// ---------------------------------------------------------------- mempool and fees

export interface ProjectedBlock {
  txs: number;
  vsize: number;
  totalFees: number;
  medianFee: number;
  minFee: number | null;
  maxFee: number | null;
}

/** mempool.space `GET /v1/fees/mempool-blocks`: the blocks miners would build from the mempool now. */
export function parseProjectedBlocks(body: unknown): ProjectedBlock[] {
  const out: ProjectedBlock[] = [];
  for (const raw of list(body)) {
    const b = rec(raw);
    const range = list(b.feeRange).map(n).filter((v): v is number => v !== null);
    const median = n(b.medianFee);
    if (median === null) continue;
    out.push({ txs: n(b.nTx) ?? 0, vsize: n(b.blockVSize) ?? 0, totalFees: n(b.totalFees) ?? 0, medianFee: median, minFee: range.length ? Math.min(...range) : null, maxFee: range.length ? Math.max(...range) : null });
  }
  return out;
}

const mempoolCard: CardDef = {
  id: 'crypto.btc-mempool',
  title: 'Mempool and Fees',
  source: MEMPOOL,
  description: 'Bitcoin fee estimates by confirmation speed, the size of the mempool, and the next blocks as miners would build them now.',
  async run(ctx) {
    const [fees, pool, blocks, prices] = await Promise.all([
      mempool<unknown>(ctx, '/v1/fees/recommended', 30).then(rec),
      mempool<unknown>(ctx, '/mempool', 30).then(rec),
      mempool<unknown>(ctx, '/v1/fees/mempool-blocks', 30).then(parseProjectedBlocks),
      mempool<unknown>(ctx, '/v1/prices', 300).then(rec).catch(() => ({}) as Record<string, unknown>),
    ]);
    const fast = n(fees.fastestFee);
    if (fast === null) throw new SourceError(MEMPOOL, 'no fee estimates returned');
    const usd = n(prices.USD);
    // A typical one-input, two-output native SegWit payment is about 140 virtual bytes.
    const cost = (rate: number | null) => (rate === null || usd === null ? null : (rate * 140 * usd) / SATS);
    const tiers: Row[] = [
      ['Next block', 'fastestFee'],
      ['Within 30 minutes', 'halfHourFee'],
      ['Within an hour', 'hourFee'],
      ['Economy', 'economyFee'],
      ['Minimum to relay', 'minimumFee'],
    ].map(([label, key]) => ({ target: label, rate: n(fees[key]), cost: cost(n(fees[key])) }));
    const vsize = n(pool.vsize);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Next block (sat/vB)', value: fast, format: 'num', digits: 1 },
            { label: 'Typical payment', value: cost(fast), format: 'usd', digits: 3 },
            { label: 'Unconfirmed', value: n(pool.count), format: 'int' },
            { label: 'Mempool size (vMB)', value: vsize === null ? null : vsize / 1e6, format: 'num', digits: 1 },
            { label: 'Blocks to clear it', value: vsize === null ? null : vsize / 1e6, format: 'num', digits: 0 },
            { label: 'Fees waiting (BTC)', value: n(pool.total_fee) === null ? null : (n(pool.total_fee) as number) / SATS, format: 'num', digits: 3 },
          ],
        },
        {
          kind: 'table',
          title: 'Fee to confirm',
          columns: [
            { key: 'target', label: 'Target' },
            { key: 'rate', label: 'Fee (sat/vB)', format: 'num', digits: 1 },
            { key: 'cost', label: 'Typical payment', format: 'usd', digits: 3 },
          ],
          rows: tiers,
        },
        {
          kind: 'table',
          title: 'Projected next blocks',
          columns: [
            { key: 'block', label: 'Block' },
            { key: 'txs', label: 'Transactions', format: 'int' },
            { key: 'size', label: 'Size (vMB)', format: 'num', digits: 2 },
            { key: 'medianFee', label: 'Median fee (sat/vB)', format: 'num', digits: 2 },
            { key: 'minFee', label: 'Lowest', format: 'num', digits: 2 },
            { key: 'maxFee', label: 'Highest', format: 'num', digits: 1 },
            { key: 'fees', label: 'Fees (BTC)', format: 'num', digits: 4 },
          ],
          rows: blocks.map((b, i) => ({ block: i === 0 ? 'next' : `+${i + 1}`, txs: b.txs, size: b.vsize / 1e6, medianFee: b.medianFee, minFee: b.minFee, maxFee: b.maxFee, fees: b.totalFees / SATS })),
        },
      ],
      sourceUrl: 'https://mempool.space/',
      asOf: ctx.now().toISOString().slice(0, 19) + 'Z',
      notes: ['Fees are in satoshis per virtual byte. The dollar cost is for a typical 140 vB payment (one input, two outputs) at the current price. The last projected block stands for everything further back in the queue.'],
    };
  },
};

// ---------------------------------------------------------------- recent blocks

const blocksCard: CardDef = {
  id: 'crypto.btc-blocks',
  title: 'Recent Blocks',
  source: MEMPOOL,
  description: 'The latest bitcoin blocks: height, time, who mined each, transactions, size, fees and the total reward.',
  async run(ctx) {
    const rows: Row[] = [];
    for (const raw of list(await mempool<unknown>(ctx, '/v1/blocks', 60))) {
      const b = rec(raw);
      const x = rec(b.extras);
      const height = n(b.height);
      const ts = n(b.timestamp);
      if (height === null || ts === null) continue;
      rows.push({
        height,
        time: ts * 1000,
        pool: str(rec(x.pool).name),
        txs: n(b.tx_count),
        size: n(b.size) === null ? null : (n(b.size) as number) / 1e6,
        full: n(b.weight) === null ? null : ((n(b.weight) as number) / 4e6) * 100,
        medianFee: n(x.medianFee),
        fees: n(x.totalFees) === null ? null : (n(x.totalFees) as number) / SATS,
        reward: n(x.reward) === null ? null : (n(x.reward) as number) / SATS,
      });
    }
    if (rows.length < 2) throw new SourceError(MEMPOOL, 'no blocks returned');
    const times = rows.map((r) => r.time as number);
    const avgGap = (Math.max(...times) - Math.min(...times)) / (rows.length - 1) / 60_000;
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Latest block', value: rows[0].height, format: 'int' },
            { label: 'Minutes since', value: (ctx.now().getTime() - (rows[0].time as number)) / 60_000, format: 'num', digits: 0 },
            { label: 'Average gap (minutes)', value: avgGap, format: 'num', digits: 1 },
            { label: 'Fees per block (BTC)', value: sum(rows.map((r) => r.fees as number | null)) / rows.length, format: 'num', digits: 4 },
            { label: 'Fee share of reward', value: share(sum(rows.map((r) => r.fees as number | null)), sum(rows.map((r) => r.reward as number | null))), format: 'pct', digits: 2 },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'height', label: 'Height', format: 'int' },
            { key: 'time', label: 'Mined (UTC)', format: 'datetime' },
            { key: 'pool', label: 'Pool', maxWidth: 20 },
            { key: 'txs', label: 'Transactions', format: 'int' },
            { key: 'size', label: 'Size (MB)', format: 'num', digits: 2 },
            { key: 'full', label: 'Full', format: 'pct', digits: 0 },
            { key: 'medianFee', label: 'Median fee (sat/vB)', format: 'num', digits: 2 },
            { key: 'fees', label: 'Fees (BTC)', format: 'num', digits: 4 },
            { key: 'reward', label: 'Reward (BTC)', format: 'num', digits: 4 },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://mempool.space/blocks',
      asOf: new Date(rows[0].time as number).toISOString().slice(0, 16) + 'Z',
      notes: ['Reward is the block subsidy plus fees. "Full" is the block weight against the 4 million unit limit.'],
    };
  },
};

// ---------------------------------------------------------------- hashrate and difficulty

const HASH_WINDOW: Record<string, string> = { '1M': '1m', '3M': '3m', '6M': '6m', '1Y': '1y', '2Y': '2y', '5Y': 'all', '10Y': 'all', MAX: 'all' };

export interface Hashrate {
  /** [ms, exahashes per second], oldest first. */
  hashrate: [number, number][];
  /** [ms, difficulty], oldest first. */
  difficulty: [number, number][];
  current: number | null;
  currentDifficulty: number | null;
}

/** mempool.space `GET /v1/mining/hashrate/{window}`. Hashrate is converted from H/s to EH/s. */
export function parseHashrate(body: unknown): Hashrate {
  const b = rec(body);
  const hashrate: [number, number][] = [];
  for (const raw of list(b.hashrates)) {
    const t = n(rec(raw).timestamp);
    const v = n(rec(raw).avgHashrate);
    if (t !== null && v !== null) hashrate.push([t * 1000, v / 1e18]);
  }
  const difficulty: [number, number][] = [];
  for (const raw of list(b.difficulty)) {
    const t = n(rec(raw).time);
    const v = n(rec(raw).difficulty);
    if (t !== null && v !== null) difficulty.push([t * 1000, v]);
  }
  const cur = n(b.currentHashrate);
  return { hashrate: hashrate.sort((a, c) => a[0] - c[0]), difficulty: difficulty.sort((a, c) => a[0] - c[0]), current: cur === null ? null : cur / 1e18, currentDifficulty: n(b.currentDifficulty) };
}

const hashrateCard: CardDef = {
  id: 'crypto.btc-hashrate',
  title: 'Hashrate',
  source: MEMPOOL,
  description: 'The computing power securing bitcoin, in exahashes per second, through time, with the change over a month and a year.',
  params: [{ name: 'range', label: 'Range', default: '1Y', choices: RANGE_CHOICES }],
  async run(ctx, params) {
    const range = (params.range ?? '1Y').toUpperCase();
    const h = parseHashrate(await mempool<unknown>(ctx, `/v1/mining/hashrate/${HASH_WINDOW[range] ?? '1y'}`, 1800));
    if (h.hashrate.length < 2) throw new SourceError(MEMPOOL, 'no hashrate history returned');
    const pts = h.hashrate;
    const last30 = pts.slice(-30).map((p) => p[1]);
    const peak = pts.reduce((m, p) => (p[1] > m[1] ? p : m), pts[0]);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Hashrate now (EH/s)', value: h.current ?? pts[pts.length - 1][1], format: 'num', digits: 0 },
            { label: '30-day average (EH/s)', value: sum(last30) / last30.length, format: 'num', digits: 0 },
            { label: '30 days', value: changeOver(pts, 30), format: 'signedPct' },
            { label: '90 days', value: changeOver(pts, 90), format: 'signedPct' },
            { label: '1 year', value: changeOver(pts, 365), format: 'signedPct' },
            { label: 'Highest in range (EH/s)', value: peak[1], format: 'num', digits: 0 },
            { label: 'Set on', value: new Date(peak[0]).toISOString().slice(0, 10) },
            { label: 'Difficulty', value: h.currentDifficulty, format: 'compact' },
          ],
        },
        { kind: 'chart', title: 'Bitcoin hashrate, daily average (EH/s)', xType: 'time', yFormat: 'num', yDigits: 0, series: [{ name: 'Hashrate', points: clip(pts, range) }] },
      ],
      sourceUrl: 'https://mempool.space/graphs/mining/hashrate-difficulty',
      asOf: new Date(pts[pts.length - 1][0]).toISOString().slice(0, 10),
      notes: ['Hashrate is not measured directly: it is estimated from how fast blocks arrive against the difficulty, so daily figures are noisy and the 30-day average is the better read.'],
    };
  },
};

export interface Adjustment {
  t: number;
  height: number;
  difficulty: number;
  /** Percent change against the period before. */
  change: number;
}

/** mempool.space `GET /v1/mining/difficulty-adjustments/{window}`: [seconds, height, difficulty, ratio to the last], newest first. */
export function parseAdjustments(body: unknown): Adjustment[] {
  const out: Adjustment[] = [];
  for (const raw of list(body)) {
    const [t, height, difficulty, ratio] = list(raw).map(n);
    if (t == null || height == null || difficulty == null || ratio == null) continue;
    out.push({ t: t * 1000, height, difficulty, change: (ratio - 1) * 100 });
  }
  return out.sort((a, b) => b.t - a.t);
}

const difficultyCard: CardDef = {
  id: 'crypto.btc-difficulty',
  title: 'Difficulty and Next Adjustment',
  source: MEMPOOL,
  description: 'The expected size and date of the next bitcoin difficulty adjustment, progress through the current period, and past adjustments.',
  async run(ctx) {
    const [da, past] = await Promise.all([mempool<unknown>(ctx, '/v1/difficulty-adjustment', 300).then(rec), mempool<unknown>(ctx, '/v1/mining/difficulty-adjustments/1y', 3600).then(parseAdjustments)]);
    if (n(da.remainingBlocks) === null) throw new SourceError(MEMPOOL, 'no difficulty estimate returned');
    const asc = [...past].reverse();
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Next adjustment', value: n(da.difficultyChange), format: 'signedPct' },
            { label: 'Expected on', value: n(da.estimatedRetargetDate), format: 'datetime' },
            { label: 'Blocks to go', value: n(da.remainingBlocks), format: 'int' },
            { label: 'Period complete', value: n(da.progressPercent), format: 'pct' },
            { label: 'Block time (minutes)', value: n(da.timeAvg) === null ? null : (n(da.timeAvg) as number) / 60_000, format: 'num', digits: 2 },
            { label: 'Adjusts at block', value: n(da.nextRetargetHeight), format: 'int' },
            { label: 'Previous adjustment', value: n(da.previousRetarget), format: 'signedPct' },
            { label: 'Difficulty now', value: past[0]?.difficulty, format: 'compact' },
          ],
        },
        ...(asc.length > 1 ? [{ kind: 'chart' as const, title: 'Difficulty at each adjustment, last year', xType: 'time' as const, yFormat: 'compact' as const, series: [{ name: 'Difficulty', points: asc.map((a): [number, number] => [a.t, a.difficulty]) }] }] : []),
        {
          kind: 'table',
          title: 'Past adjustments, newest first',
          columns: [
            { key: 'date', label: 'Date', format: 'date' },
            { key: 'height', label: 'Block', format: 'int' },
            { key: 'difficulty', label: 'Difficulty', format: 'compact' },
            { key: 'change', label: 'Change', format: 'signedPct' },
          ],
          rows: past.slice(0, 26).map((a) => ({ date: a.t, height: a.height, difficulty: a.difficulty, change: a.change })),
        },
      ],
      sourceUrl: 'https://mempool.space/graphs/mining/hashrate-difficulty',
      asOf: minuteStamp(ctx),
      notes: ['Difficulty resets every 2,016 blocks so that blocks keep arriving about every ten minutes. Blocks coming faster than that mean hashrate has grown and difficulty will rise.'],
    };
  },
};

// ---------------------------------------------------------------- mining pools

export interface MiningPool {
  name: string;
  blocks: number;
  empty: number;
}

/** mempool.space `GET /v1/mining/pools/{window}`, largest first. */
export function parsePools(body: unknown): { pools: MiningPool[]; total: number; hashrate: number | null } {
  const b = rec(body);
  const pools: MiningPool[] = [];
  for (const raw of list(b.pools)) {
    const p = rec(raw);
    const blocks = n(p.blockCount);
    if (str(p.name) && blocks !== null && blocks > 0) pools.push({ name: str(p.name), blocks, empty: n(p.emptyBlocks) ?? 0 });
  }
  pools.sort((a, c) => c.blocks - a.blocks);
  const hr = n(b.lastEstimatedHashrate);
  return { pools, total: n(b.blockCount) ?? sum(pools.map((p) => p.blocks)), hashrate: hr === null ? null : hr / 1e18 };
}

const poolsCard: CardDef = {
  id: 'crypto.btc-pools',
  title: 'Mining Pools',
  source: MEMPOOL,
  description: 'Which mining pools found bitcoin\'s recent blocks, each pool\'s share and estimated hashrate, and how concentrated mining is.',
  params: [{ name: 'window', label: 'Window', default: '1w', choices: ['24h', '3d', '1w', '1m', '3m', '6m', '1y'] }],
  async run(ctx, params) {
    const window = ['24h', '3d', '1w', '1m', '3m', '6m', '1y'].includes(params.window) ? params.window : '1w';
    const { pools, total, hashrate } = parsePools(await mempool<unknown>(ctx, `/v1/mining/pools/${window}`, 900));
    if (!pools.length) throw new SourceError(MEMPOOL, 'no pools returned');
    const top = pools.slice(0, 12);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: `Blocks, last ${window}`, value: total, format: 'int' },
            { label: 'Pools that found one', value: pools.length, format: 'int' },
            { label: `${pools[0].name} share`, value: share(pools[0].blocks, total), format: 'pct' },
            { label: 'Top 2 pools', value: share(sum(pools.slice(0, 2).map((p) => p.blocks)), total), format: 'pct' },
            { label: 'Top 4 pools', value: share(sum(pools.slice(0, 4).map((p) => p.blocks)), total), format: 'pct' },
            { label: 'Network hashrate (EH/s)', value: hashrate, format: 'num', digits: 0 },
          ],
        },
        {
          kind: 'chart',
          title: `Share of blocks found, last ${window} (%)`,
          xType: 'category',
          style: 'bar',
          yFormat: 'pct',
          categories: top.map((p) => p.name),
          series: [{ name: 'Share', points: top.map((p, i): [number, number] => [i, share(p.blocks, total) ?? 0]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Pool' },
            { key: 'blocks', label: 'Blocks', format: 'int' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'hashrate', label: 'Est. hashrate (EH/s)', format: 'num', digits: 1 },
            { key: 'empty', label: 'Empty blocks', format: 'int' },
          ],
          rows: pools.map((p, i) => ({ rank: i + 1, name: p.name, blocks: p.blocks, share: share(p.blocks, total), hashrate: hashrate === null ? null : (hashrate * p.blocks) / total, empty: p.empty })),
        },
      ],
      sourceUrl: 'https://mempool.space/graphs/mining/pools',
      asOf: minuteStamp(ctx),
      notes: ['A pool is identified by the tag it writes in the blocks it finds. Shares over a day are noisy because finding a block is chance; a week or more is steadier. Several pools are known to share one block template, so real concentration is higher than the table shows.'],
    };
  },
};

// ---------------------------------------------------------------- miner economics

const minerEconomics: CardDef = {
  id: 'crypto.btc-miner-revenue',
  title: 'Miner Revenue',
  source: MEMPOOL,
  description: 'What miners earned over the last 144 blocks (about a day): subsidy and fees in bitcoin and dollars, the fee share, and revenue per unit of hashrate.',
  async run(ctx) {
    const [stats, prices, hr] = await Promise.all([
      mempool<unknown>(ctx, '/v1/mining/reward-stats/144', 600).then(rec),
      mempool<unknown>(ctx, '/v1/prices', 300).then(rec),
      mempool<unknown>(ctx, '/v1/mining/hashrate/1m', 1800).then(parseHashrate),
    ]);
    const reward = n(stats.totalReward);
    const fee = n(stats.totalFee);
    if (reward === null || fee === null) throw new SourceError(MEMPOOL, 'no reward statistics returned');
    const usd = n(prices.USD);
    const rewardBtc = reward / SATS;
    const feeBtc = fee / SATS;
    const txs = n(stats.totalTx);
    const hash = hr.current ?? hr.hashrate[hr.hashrate.length - 1]?.[1] ?? null;
    const revenueUsd = usd === null ? null : rewardBtc * usd;
    return {
      blocks: [
        {
          kind: 'stats',
          title: `Blocks ${str(stats.startBlock)} to ${str(stats.endBlock)}`,
          items: [
            { label: 'Total reward (BTC)', value: rewardBtc, format: 'num', digits: 2 },
            { label: 'Total reward', value: revenueUsd, format: 'usdCompact' },
            { label: 'Subsidy (BTC)', value: rewardBtc - feeBtc, format: 'num', digits: 2 },
            { label: 'Fees (BTC)', value: feeBtc, format: 'num', digits: 3 },
            { label: 'Fees', value: usd === null ? null : feeBtc * usd, format: 'usdCompact' },
            { label: 'Fee share of reward', value: share(feeBtc, rewardBtc), format: 'pct', digits: 2 },
            { label: 'Transactions', value: txs, format: 'int' },
            { label: 'Fee per transaction', value: usd !== null && txs ? (feeBtc * usd) / txs : null, format: 'usd', digits: 3 },
            { label: 'Reward per transaction', value: revenueUsd !== null && txs ? revenueUsd / txs : null, format: 'usd' },
            { label: 'Network hashrate (EH/s)', value: hash, format: 'num', digits: 0 },
            { label: 'Revenue per PH/s per day', value: revenueUsd !== null && hash ? revenueUsd / (hash * 1000) : null, format: 'usd' },
            { label: 'Bitcoin price', value: usd, format: 'usd', digits: 0 },
          ],
        },
      ],
      sourceUrl: 'https://mempool.space/mining',
      asOf: minuteStamp(ctx),
      notes: ['144 blocks is one day at ten-minute blocks; the actual span is a little shorter or longer. Revenue per PH/s per day ("hashprice") is the dollar reward divided by the network hashrate, before power and pool costs.'],
    };
  },
};

// ---------------------------------------------------------------- Lightning (1ML)

export const ONE_ML = '1ML';

export interface LightningNode {
  alias: string;
  /** BTC. */
  capacity: number;
  channels: number;
}

/** 1ML `GET /node?order=...&json=true` to nodes, in the order given. */
export function parseLightningNodes(body: unknown): LightningNode[] {
  const out: LightningNode[] = [];
  for (const raw of list(body)) {
    const x = rec(raw);
    const cap = n(x.capacity);
    const channels = n(x.channelcount);
    if (cap === null || channels === null) continue;
    // Aliases are free text chosen by the operator; keep printable ASCII only.
    const alias = str(x.alias).replace(/[^\x20-\x7e]/g, '').trim() || `${str(x.pub_key).slice(0, 16)}...`;
    out.push({ alias, capacity: cap / SATS, channels });
  }
  return out;
}

const oneMl = (ctx: Ctx, path: string) => ctx.http.json<unknown>(`https://1ml.com/${path}`, { source: ONE_ML, ttl: 3600 });

const lightning: CardDef = {
  id: 'crypto.btc-lightning',
  title: 'Lightning Network',
  source: ONE_ML,
  description: 'The public Lightning Network as 1ML sees it: nodes, channels and capacity with the 30-day change, typical channel size and fees, and the largest nodes.',
  async run(ctx) {
    const [stats, byCap, byChan] = await Promise.all([
      oneMl(ctx, 'statistics?json=true').then(rec),
      oneMl(ctx, 'node?order=capacity&json=true').then(parseLightningNodes).catch(() => [] as LightningNode[]),
      oneMl(ctx, 'node?order=channelcount&json=true').then(parseLightningNodes).catch(() => [] as LightningNode[]),
    ]);
    const capacity = n(stats.networkcapacity);
    if (capacity === null || !(capacity > 0)) throw new SourceError(ONE_ML, 'no network statistics returned');
    const total = capacity / SATS;
    const nodeColumns = [
      { key: 'rank', label: '#', format: 'int' as const },
      { key: 'alias', label: 'Node', maxWidth: 30 },
      { key: 'capacity', label: 'Capacity (BTC)', format: 'num' as const, digits: 1 },
      { key: 'share', label: 'Of network capacity', format: 'pct' as const },
      { key: 'channels', label: 'Channels', format: 'int' as const },
    ];
    const nodeRows = (nodes: LightningNode[], count: number): Row[] => nodes.slice(0, count).map((x, i) => ({ rank: i + 1, alias: x.alias, capacity: x.capacity, share: share(x.capacity, total), channels: x.channels }));
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Capacity (BTC)', value: total, format: 'num', digits: 0 },
            { label: 'Capacity', value: n(stats.networkcapacityusd), format: 'usdCompact' },
            { label: 'Capacity, 30 days', value: n(stats.networkcapacity30dchange), format: 'signedPct' },
            { label: 'Channels', value: n(stats.numberofchannels), format: 'int' },
            { label: 'Channels, 30 days', value: n(stats.numberofchannels30dchange), format: 'signedPct' },
            { label: 'Nodes', value: n(stats.numberofnodes), format: 'int' },
            { label: 'Nodes, 30 days', value: n(stats.numberofnodes30dchange), format: 'signedPct' },
            { label: 'Tor nodes', value: n(stats.tornodes), format: 'int' },
            { label: 'Average channel (BTC)', value: n(stats.averagechannelcapacity), format: 'num', digits: 4 },
            { label: 'Channels per node', value: n(stats.averagechannelpernode), format: 'num', digits: 1 },
            { label: 'New channels, 24 hours', value: n(stats.newchannels24h), format: 'int' },
            { label: 'Median fee rate (ppm)', value: n(stats.medianfeerate) === null ? null : (n(stats.medianfeerate) as number) * 1e6, format: 'num', digits: 0 },
          ],
        },
        ...(byCap.length ? [{ kind: 'table' as const, title: 'Largest nodes by capacity', columns: nodeColumns, rows: nodeRows(byCap, 15) }] : []),
        ...(byChan.length ? [{ kind: 'table' as const, title: 'Largest nodes by channels', columns: nodeColumns, rows: nodeRows(byChan, 10) }] : []),
      ],
      sourceUrl: 'https://1ml.com/statistics',
      asOf: minuteStamp(ctx),
      notes: [
        'Public channels only, as the 1ML node sees the network. Private channels are never announced, and other explorers report different totals because each sees the network from its own node.',
        'Node names are the aliases operators choose for themselves. A channel counts toward both of its nodes, so the capacity shares add up to more than 100%. Refreshed here once an hour.',
      ],
    };
  },
};

// ---------------------------------------------------------------- network activity (blockchain.com)

export const BLOCKCHAIN = 'Blockchain.com';

const ACTIVITY: Record<string, { chart: string; title: string; format: 'int' | 'usdCompact' | 'num' | 'compact' | 'usd'; digits?: number; total?: boolean }> = {
  transactions: { chart: 'n-transactions', title: 'Confirmed transactions per day', format: 'int', total: true },
  addresses: { chart: 'n-unique-addresses', title: 'Unique addresses used per day', format: 'int' },
  'value moved': { chart: 'estimated-transaction-volume-usd', title: 'Estimated value transferred per day (USD)', format: 'usdCompact', total: true },
  fees: { chart: 'transaction-fees-usd', title: 'Total transaction fees per day (USD)', format: 'usdCompact', total: true },
  'miner revenue': { chart: 'miners-revenue', title: 'Miner revenue per day (USD)', format: 'usdCompact', total: true },
  'cost per transaction': { chart: 'cost-per-transaction', title: 'Miner revenue per transaction (USD)', format: 'usd' },
  'block size': { chart: 'avg-block-size', title: 'Average block size (MB)', format: 'num', digits: 2 },
  'unspent outputs': { chart: 'utxo-count', title: 'Unspent transaction outputs', format: 'compact' },
  'market cap': { chart: 'market-cap', title: 'Bitcoin market capitalization (USD)', format: 'usdCompact' },
};

const TIMESPAN: Record<string, string> = { '1M': '30days', '3M': '90days', '6M': '180days', '1Y': '1year', '2Y': '2years', '5Y': '5years', '10Y': '10years', MAX: 'all' };

/** Blockchain.com charts API (`values: [{x: seconds, y}]`) to an ascending [ms, value] series. */
export function parseBlockchainChart(body: unknown): [number, number][] {
  const out: [number, number][] = [];
  for (const raw of list(rec(body).values)) {
    const t = n(rec(raw).x);
    const v = n(rec(raw).y);
    if (t !== null && v !== null) out.push([t * 1000, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const activity: CardDef = {
  id: 'crypto.btc-activity',
  title: 'Network Activity',
  source: BLOCKCHAIN,
  description: 'Daily bitcoin network activity: transactions, addresses used, value moved, fees, miner revenue, block size, unspent outputs or market cap.',
  params: [
    { name: 'series', label: 'Series', default: 'transactions', choices: Object.keys(ACTIVITY) },
    { name: 'range', label: 'Range', default: '1Y', choices: Object.keys(TIMESPAN) },
  ],
  async run(ctx, params) {
    const key = ACTIVITY[params.series] ? params.series : 'transactions';
    const def = ACTIVITY[key];
    const range = (params.range ?? '1Y').toUpperCase();
    const body = await ctx.http.json<unknown>(`https://api.blockchain.info/charts/${def.chart}?timespan=${TIMESPAN[range] ?? '1year'}&format=json&sampled=true`, { source: BLOCKCHAIN, ttl: 3600 });
    const pts = parseBlockchainChart(body);
    if (pts.length < 2) throw new SourceError(BLOCKCHAIN, `no data for ${key}`);
    const last = pts[pts.length - 1];
    const values = pts.map((p) => p[1]);
    const last30 = pts.filter((p) => p[0] > last[0] - 30 * DAY).map((p) => p[1]);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Latest', value: last[1], format: def.format, digits: def.digits },
            { label: '30-day average', value: sum(last30) / last30.length, format: def.format, digits: def.digits },
            { label: '30 days', value: changeOver(pts, 30), format: 'signedPct' },
            { label: `${range} high`, value: Math.max(...values), format: def.format, digits: def.digits },
            { label: `${range} low`, value: Math.min(...values), format: def.format, digits: def.digits },
            { label: `${range} change`, value: pts[0][1] ? (last[1] / pts[0][1] - 1) * 100 : null, format: 'signedPct' },
          ],
        },
        { kind: 'chart', title: def.title, xType: 'time', yFormat: def.format, yDigits: def.digits, series: [{ name: key, points: pts }] },
      ],
      sourceUrl: `https://www.blockchain.com/explorer/charts/${def.chart}`,
      asOf: new Date(last[0]).toISOString().slice(0, 10),
      notes: [str(rec(body).description) || def.title, 'Long ranges are sampled by the source, so each point can stand for several days.'].filter(Boolean),
    };
  },
};

export const bitcoinCards: CardDef[] = [mempoolCard, blocksCard, hashrateCard, difficultyCard, halving, poolsCard, minerEconomics, lightning, activity];
