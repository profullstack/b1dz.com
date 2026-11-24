/** Equity Options dashboard: dealer gamma and Max Pain, the realised-volatility cone, and strategy quotes. */
import { getHistory } from '../../lib/market.js';
import { SourceError, type CardDef, type Ctx, type ParamSpec, type Row } from '../../types.js';
import { atmIv, daysTo, loadChain, type Chain, type OptionQuote } from './chain.js';
import { dailyCloses } from './deribit.js';
import { breakevens, gammaExposure, maxPain, netCost, payoffAtExpiry, payoffCurve, volCone, type Leg } from './optionmath.js';
import { EXPIRY_PARAM, SYMBOL_PARAM, finish, pct, setup } from './options.js';

const gammaCard: CardDef = {
  id: 'derivatives.options-gamma',
  title: 'Dealer Gamma Exposure and Max Pain',
  source: 'Nasdaq',
  description: 'Estimated dealer gamma exposure by strike across every expiry, with the Max Pain strike for the chosen expiry.',
  params: [SYMBOL_PARAM, EXPIRY_PARAM],
  async run(ctx, params) {
    const s = await setup(ctx, params);
    const { chain } = s;
    const all = gammaExposure(chain.quotes, chain.spot, chain.multiplier);
    if (!all.length) throw new SourceError(chain.source, `${chain.symbol}: no contract has both open interest and a usable quote`);
    const total = all.reduce((a, r) => a + r.net, 0);
    const near = all.filter((r) => r.strike >= chain.spot * 0.8 && r.strike <= chain.spot * 1.2);
    // A terminal draws one bar per row: keep the chart to the 36 strikes closest to the underlying.
    const charted = [...near].sort((a, b) => Math.abs(a.strike - chain.spot) - Math.abs(b.strike - chain.spot)).slice(0, 36).sort((a, b) => a.strike - b.strike);
    const pain = maxPain(s.quotes);
    const painAll = maxPain(chain.quotes);
    const top = [...near].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 25).sort((a, b) => a.strike - b.strike);
    // Where cumulative exposure (low strikes upward) turns from negative to positive.
    let flip: number | null = null;
    let run = 0;
    for (const r of all) {
      const before = run;
      run += r.net;
      if (before < 0 && run >= 0) flip = r.strike;
    }
    return finish(
      chain,
      [
        {
          kind: 'stats',
          items: [
            { label: chain.multiplier === 1 ? 'Index' : 'Underlying', value: chain.spot, format: 'num', digits: 2 },
            { label: 'Net gamma exposure per 1% move', value: total, format: 'usdCompact' },
            { label: `Max Pain, ${s.expiry}`, value: pain, format: 'num', digits: 2 },
            { label: 'Max Pain, all expiries', value: painAll, format: 'num', digits: 2 },
            { label: 'Cumulative gamma turns positive at', value: flip, format: 'num', digits: 2 },
            { label: 'Largest positive strike', value: [...all].sort((a, b) => b.net - a.net)[0]?.strike, format: 'num', digits: 2 },
            { label: 'Largest negative strike', value: [...all].sort((a, b) => a.net - b.net)[0]?.strike, format: 'num', digits: 2 },
          ],
        },
        {
          kind: 'chart',
          title: `${chain.symbol}: net gamma exposure by strike, all expiries (${chain.currency} per 1% move)`,
          xType: 'number',
          xLabel: 'Strike',
          style: 'bar',
          yFormat: 'usdCompact',
          series: [{ name: 'Net gamma exposure', points: charted.map((r) => [r.strike, r.net]) }],
        },
        {
          kind: 'table',
          title: 'Largest strikes within 20% of the underlying',
          columns: [
            { key: 'strike', label: 'Strike', format: 'num', digits: 2 },
            { key: 'call', label: 'Call gamma', format: 'usdCompact' },
            { key: 'put', label: 'Put gamma', format: 'usdCompact' },
            { key: 'net', label: 'Net', format: 'usdCompact' },
          ],
          rows: top.map((r) => ({ ...r })),
        },
      ],
      [
        `Gamma exposure = gamma x open interest x ${chain.multiplier} x underlying^2 x 1%, with calls counted positive and puts negative. That sign convention assumes dealers are long calls and short puts against customers; it is a common modelling assumption, not reported positioning.`,
        'Max Pain is the strike at which option holders would collect the least at expiry, given current open interest.',
        'Contracts with no two-sided quote have no implied volatility here and are left out of the gamma sum.',
      ],
    );
  },
};

/** Daily closes of a chain's underlying, oldest first. */
async function underlyingCloses(ctx: Ctx, chain: Chain): Promise<{ closes: number[]; source: string }> {
  if (chain.multiplier === 1) {
    const bars = await dailyCloses(ctx, `${chain.symbol}-PERPETUAL`, 760);
    return { closes: bars.map((b) => b[1]), source: 'Deribit' };
  }
  const h = await getHistory(ctx, chain.symbol, '2Y');
  return { closes: h.bars.map((b) => b.c), source: h.source };
}

const coneCard: CardDef = {
  id: 'derivatives.options-vol-cone',
  title: 'Realised Volatility Cone vs Implied',
  source: 'Nasdaq',
  description: 'The range of realised volatility over 10 to 126 trading days across two years, with at-the-money implied volatility by horizon alongside.',
  params: [SYMBOL_PARAM],
  async run(ctx, params) {
    const chain = await loadChain(ctx, params.symbol ?? 'AAPL');
    const hist = await underlyingCloses(ctx, chain);
    const cone = volCone(hist.closes, undefined, chain.periods);
    if (!cone.length) throw new SourceError(hist.source, `${chain.symbol}: not enough price history for a volatility cone`);
    const now = ctx.now();
    // Implied vol by horizon, with days to expiry converted to the same day count as the cone's windows.
    const implied: { expiry: string; x: number; iv: number }[] = [];
    for (const e of chain.expiries) {
      const iv = atmIv(chain, e);
      const days = daysTo(e, now);
      if (iv === null || days < 1) continue;
      implied.push({ expiry: e, x: (days * chain.periods) / 365, iv: iv * 100 });
    }
    const nearest = (window: number): { expiry: string; iv: number } | null => {
      let best: (typeof implied)[number] | null = null;
      for (const p of implied) if (!best || Math.abs(p.x - window) < Math.abs(best.x - window)) best = p;
      return best;
    };
    const line = (name: string, pick: (c: (typeof cone)[number]) => number) => ({ name, points: cone.map((c): [number, number] => [c.window, pick(c) * 100]) });
    const rows: Row[] = cone.map((c) => {
      const iv = nearest(c.window);
      return {
        window: c.window,
        min: c.min * 100,
        p10: c.p10 * 100,
        median: c.median * 100,
        p90: c.p90 * 100,
        max: c.max * 100,
        current: c.current * 100,
        iv: iv?.iv,
        spread: iv ? iv.iv - c.current * 100 : null,
        expiry: iv?.expiry,
      };
    });
    const unit = chain.periods === 365 ? 'days' : 'trading days';
    const result = finish(
      chain,
      [
        {
          kind: 'chart',
          title: `${chain.symbol}: realised volatility cone and ATM implied volatility (x = ${unit})`,
          xType: 'number',
          xLabel: chain.periods === 365 ? 'Days' : 'Trading days',
          yFormat: 'pct',
          yDigits: 0,
          series: [
            line('Max', (c) => c.max),
            line('90th pct', (c) => c.p90),
            line('Median', (c) => c.median),
            line('10th pct', (c) => c.p10),
            line('Min', (c) => c.min),
            line('Realised now', (c) => c.current),
            { name: 'ATM implied', points: implied.filter((p) => p.x >= 5 && p.x <= 140).map((p): [number, number] => [p.x, p.iv]) },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'window', label: `Window (${unit})`, format: 'int' },
            { key: 'min', label: 'Min', format: 'pct', digits: 1 },
            { key: 'p10', label: '10th', format: 'pct', digits: 1 },
            { key: 'median', label: 'Median', format: 'pct', digits: 1 },
            { key: 'p90', label: '90th', format: 'pct', digits: 1 },
            { key: 'max', label: 'Max', format: 'pct', digits: 1 },
            { key: 'current', label: 'Realised now', format: 'pct', digits: 1 },
            { key: 'iv', label: 'ATM implied', format: 'pct', digits: 1 },
            { key: 'spread', label: 'Implied - realised', format: 'signed', digits: 1 },
            { key: 'expiry', label: 'Expiry used' },
          ],
          rows,
          footnote: `Realised volatility is close-to-close, annualised on ${chain.periods} days, over ${hist.closes.length} daily closes (${hist.source}). Implied is the at-the-money figure of the expiry closest to each window.`,
        },
      ],
      [],
    );
    result.source = hist.source === chain.source ? chain.source : `${chain.source}, ${hist.source}`;
    return result;
  },
};

// ---------------------------------------------------------------- strategies

export interface StrategyQuote {
  id: string;
  name: string;
  legs: Leg[];
  legsText: string;
  /** Net debit per unit of underlying. */
  cost: number;
  breakevens: number[];
  /** Two breakevens: half their width over the underlying. One: its distance from the underlying. Percent. */
  movePct: number | null;
  /** Null means unlimited. */
  maxProfit: number | null;
  maxLoss: number | null;
  /** True when a leg had no two-sided quote and its last trade was used. */
  usedLast: boolean;
}

export const STRATEGIES = ['straddle', 'strangle', 'call-spread', 'put-spread'];

function extremes(legs: Leg[]): { maxProfit: number | null; maxLoss: number | null } {
  const kinks = legs.filter((l) => l.type !== 'U').map((l) => l.strike);
  const values = [0, ...kinks].map((x) => payoffAtExpiry(legs, x));
  const top = Math.max(...kinks, 0);
  const slope = payoffAtExpiry(legs, top + 1) - payoffAtExpiry(legs, top);
  return {
    maxProfit: slope > 1e-12 ? null : Math.max(...values),
    maxLoss: slope < -1e-12 ? null : Math.min(...values),
  };
}

/**
 * Long straddle, long strangle (about 5% out of the money each side), a bull
 * call spread and a bear put spread (at the money against about 5% out), priced
 * at mid. A strategy whose legs cannot all be priced is left out.
 */
export function buildStrategies(quotes: OptionQuote[], ref: number, width = 0.05): StrategyQuote[] {
  let usedLast = false;
  const priced = quotes.filter((q) => (q.mid ?? q.last) !== null);
  const price = (q: OptionQuote): number => {
    if (q.mid === null) usedLast = true;
    return (q.mid ?? q.last) as number;
  };
  const calls = priced.filter((q) => q.type === 'C').sort((a, b) => a.strike - b.strike);
  const puts = priced.filter((q) => q.type === 'P').sort((a, b) => a.strike - b.strike);
  const nearest = (qs: OptionQuote[], target: number): OptionQuote | undefined =>
    [...qs].sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
  const both = calls.filter((c) => puts.some((p) => p.strike === c.strike));
  const atmCall = nearest(both, ref);
  const atmPut = atmCall && puts.find((p) => p.strike === atmCall.strike);
  const otmCall = calls.find((c) => c.strike >= ref * (1 + width));
  const otmPut = [...puts].reverse().find((p) => p.strike <= ref * (1 - width));
  const out: StrategyQuote[] = [];
  const add = (id: string, name: string, parts: [OptionQuote | undefined, number][]): void => {
    if (parts.some(([q]) => !q)) return;
    usedLast = false;
    const legs: Leg[] = parts.map(([q, qty]) => ({ type: (q as OptionQuote).type, strike: (q as OptionQuote).strike, qty, premium: price(q as OptionQuote) }));
    const be = breakevens(legs);
    const movePct = be.length === 2 ? ((be[1] - be[0]) / 2 / ref) * 100 : be.length === 1 ? (be[0] / ref - 1) * 100 : null;
    out.push({
      id,
      name,
      legs,
      legsText: legs.map((l) => `${l.qty > 0 ? '+' : '-'}${l.strike}${l.type}`).join(' '),
      cost: netCost(legs),
      breakevens: be,
      movePct,
      ...extremes(legs),
      usedLast,
    });
  };
  add('straddle', 'Long straddle', [[atmCall, 1], [atmPut, 1]]);
  add('strangle', 'Long strangle', [[otmPut, 1], [otmCall, 1]]);
  if (atmCall && otmCall && otmCall.strike > atmCall.strike) add('call-spread', 'Bull call spread', [[atmCall, 1], [otmCall, -1]]);
  if (atmPut && otmPut && otmPut.strike < atmPut.strike) add('put-spread', 'Bear put spread', [[atmPut, 1], [otmPut, -1]]);
  return out;
}

const STRATEGY_PARAM: ParamSpec = { name: 'strategy', label: 'Strategy', default: 'straddle', choices: STRATEGIES };

const strategiesCard: CardDef = {
  id: 'derivatives.options-strategies',
  title: 'Strategy Quotes',
  source: 'Nasdaq',
  description: 'Straddle, strangle and vertical spread prices for one expiry: cost, breakevens and the move needed to break even.',
  params: [SYMBOL_PARAM, EXPIRY_PARAM],
  async run(ctx, params) {
    const s = await setup(ctx, params);
    const list = buildStrategies(s.quotes, s.ref);
    if (!list.length) throw new SourceError(s.chain.source, `${s.chain.symbol} ${s.expiry}: no quotes to price a strategy`);
    const straddle = list.find((x) => x.id === 'straddle');
    return finish(
      s.chain,
      [
        {
          kind: 'stats',
          items: [
            { label: 'Underlying', value: s.ref, format: 'num', digits: 2 },
            { label: 'Expiry', value: s.expiry },
            { label: 'Days to expiry', value: s.days, format: 'int' },
            { label: 'Straddle cost', value: straddle?.cost, format: 'num', digits: 2 },
            { label: 'Implied move to expiry', value: straddle ? (straddle.cost / s.ref) * 100 : null, format: 'pct', digits: 1 },
            { label: 'ATM implied vol', value: pct(atmIv(s.chain, s.expiry)), format: 'pct', digits: 1 },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Strategy' },
            { key: 'legs', label: 'Legs' },
            { key: 'cost', label: 'Cost', format: 'num', digits: 2 },
            { key: 'costPct', label: 'Cost %', format: 'pct', digits: 2 },
            { key: 'be', label: 'Breakeven(s)' },
            { key: 'move', label: 'Move to b/e', format: 'signedPct', digits: 1 },
            { key: 'maxProfit', label: 'Max profit' },
            { key: 'maxLoss', label: 'Max loss', format: 'num', digits: 2 },
          ],
          rows: list.map((x) => ({
            name: x.name,
            legs: x.legsText,
            cost: x.cost,
            costPct: (x.cost / s.ref) * 100,
            be: x.breakevens.map((b) => b.toFixed(2)).join(' / '),
            move: x.movePct,
            maxProfit: x.maxProfit === null ? 'unlimited' : x.maxProfit.toFixed(2),
            maxLoss: x.maxLoss,
          })),
          footnote: `Per unit of underlying, priced at bid/ask midpoints${list.some((x) => x.usedLast) ? ' (last trade where a leg has no two-sided quote)' : ''}; one listed contract is ${s.chain.multiplier} unit${s.chain.multiplier === 1 ? '' : 's'}. Cost % is of the underlying. For two-sided strategies the move to breakeven is half the breakeven width.`,
        },
      ],
      ['The implied move is the at-the-money straddle cost as a percent of the underlying.'],
    );
  },
};

const payoffCard: CardDef = {
  id: 'derivatives.options-payoff',
  title: 'Strategy Payoff at Expiry',
  source: 'Nasdaq',
  description: 'Profit or loss at expiry across underlying prices for a chosen strategy.',
  params: [SYMBOL_PARAM, EXPIRY_PARAM, STRATEGY_PARAM],
  async run(ctx, params) {
    const s = await setup(ctx, params);
    const list = buildStrategies(s.quotes, s.ref);
    const want = (params.strategy ?? 'straddle').toLowerCase();
    const x = list.find((y) => y.id === want);
    if (!x) {
      throw new SourceError(s.chain.source, `${s.chain.symbol} ${s.expiry}: cannot price "${want}" (available: ${list.map((y) => y.id).join(', ') || 'none'})`);
    }
    const curve = payoffCurve(x.legs, s.ref * 0.75, s.ref * 1.25, 50);
    const marks = [0.8, 0.9, 0.95, 1, 1.05, 1.1, 1.2].map((m) => s.ref * m);
    return finish(s.chain, [
      {
        kind: 'chart',
        title: `${s.chain.symbol} ${s.expiry} ${x.name} (${x.legsText}): P&L at expiry per unit`,
        xType: 'number',
        xLabel: 'Underlying at expiry',
        yFormat: 'signed',
        yDigits: 2,
        series: [
          { name: 'P&L', points: curve },
          { name: 'Zero', points: [[curve[0][0], 0], [curve[curve.length - 1][0], 0]] },
        ],
      },
      {
        kind: 'table',
        columns: [
          { key: 'price', label: 'Underlying at expiry', format: 'num', digits: 2 },
          { key: 'chg', label: 'vs now', format: 'signedPct', digits: 0 },
          { key: 'pnl', label: 'P&L per unit', format: 'signed', digits: 2 },
          { key: 'ret', label: 'Return on cost', format: 'signedPct', digits: 0 },
        ],
        rows: marks.map((p) => {
          const pnl = payoffAtExpiry(x.legs, p);
          return { price: p, chg: (p / s.ref - 1) * 100, pnl, ret: x.cost > 0 ? (pnl / x.cost) * 100 : null };
        }),
        footnote: `Cost ${x.cost.toFixed(2)}; breakeven${x.breakevens.length === 1 ? '' : 's'} ${x.breakevens.map((b) => b.toFixed(2)).join(' and ')}.`,
      },
    ]);
  },
};

export const optionVolCards: CardDef[] = [gammaCard, coneCard, strategiesCard, payoffCard];
