/** Equity Options dashboard: chain, activity statistics, term structure, smile and surface. */
import type { Block, CardDef, CardResult, Column, Ctx, ParamSpec, Row } from '../../types.js';
import { atmIv, atmStrike, daysTo, loadChain, monthlyExpiries, otmSmile, pickExpiry, underlyingFor, type Chain, type OptionQuote } from './chain.js';

export const SYMBOL_PARAM: ParamSpec = {
  name: 'symbol',
  label: 'Symbol',
  default: 'AAPL',
  hint: 'U.S. stock or ETF (AAPL, SPY), Canadian listing (RY.TO), or BTC / ETH',
};

export const EXPIRY_PARAM: ParamSpec = {
  name: 'expiry',
  label: 'Expiry',
  default: 'nearest',
  hint: 'YYYY-MM-DD, or "nearest" for the next monthly expiry',
};

export interface Setup {
  chain: Chain;
  expiry: string;
  days: number;
  /** Underlying level for the chosen expiry (the forward on Deribit). */
  ref: number;
  quotes: OptionQuote[];
}

export async function setup(ctx: Ctx, params: Record<string, string>): Promise<Setup> {
  const chain = await loadChain(ctx, params.symbol ?? 'AAPL');
  const now = ctx.now();
  const expiry = pickExpiry(chain, params.expiry, now);
  return {
    chain,
    expiry,
    days: daysTo(expiry, now),
    ref: underlyingFor(chain, expiry),
    quotes: chain.quotes.filter((q) => q.expiry === expiry),
  };
}

const METHOD_NOTE =
  "Implied volatility and Greeks are computed here from bid/ask midpoints (European exercise), priced against each expiry's forward implied by put-call parity at the money, which absorbs dividends and an underlying print out of step with the option quotes. Vendor figures for American-style options differ slightly.";

export function finish(chain: Chain, blocks: Block[], extra: string[] = []): CardResult {
  const notes = [...chain.notes];
  if (chain.model === 'bs') notes.push(METHOD_NOTE, `Risk-free rate: ${chain.rateLabel}.`);
  notes.push(...extra);
  return { blocks, source: chain.source, sourceUrl: chain.sourceUrl, asOf: chain.asOf, notes };
}

export const pct = (v: number | null | undefined): number | null => (v == null ? null : v * 100);
const sum = (qs: OptionQuote[], pick: (q: OptionQuote) => number | null): number => qs.reduce((a, q) => a + (pick(q) ?? 0), 0);
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Strikes of one expiry, sorted, limited to `each` on either side of the at-the-money strike. */
export function strikesAround(quotes: OptionQuote[], atm: number | null, each: number): number[] {
  const strikes = [...new Set(quotes.map((q) => q.strike))].sort((a, b) => a - b);
  if (atm === null) return strikes.slice(0, each * 2 + 1);
  const i = strikes.indexOf(atm);
  return strikes.slice(Math.max(0, i - each), i + each + 1);
}

const chainCard: CardDef = {
  id: 'derivatives.options-chain',
  title: 'Option Chain',
  source: 'Nasdaq',
  description: 'Calls and puts around the money for one expiry: bid, ask, last, volume, open interest, implied volatility and delta.',
  params: [SYMBOL_PARAM, EXPIRY_PARAM],
  async run(ctx, params) {
    const s = await setup(ctx, params);
    return finish(s.chain, chainBlocks(s));
  },
};

/** Stats plus the calls-and-puts table around the money for the chosen expiry. */
export function chainBlocks(s: Setup): Block[] {
  const atm = atmStrike(s.chain, s.expiry);
  const by = new Map<string, OptionQuote>();
  for (const q of s.quotes) by.set(`${q.type}${q.strike}`, q);
  // Five-figure underlyings (BTC) do not need cents, and the table is wide already.
  const digits = s.ref >= 10_000 ? 0 : 2;
  const side = (prefix: string, label: string): Column[] => [
    { key: `${prefix}bid`, label: `${label} Bid`, format: 'num', digits },
    { key: `${prefix}ask`, label: `${label} Ask`, format: 'num', digits },
    { key: `${prefix}last`, label: `${label} Last`, format: 'num', digits },
    { key: `${prefix}vol`, label: `${label} Vol`, format: 'compact', digits: 1 },
    { key: `${prefix}oi`, label: `${label} OI`, format: 'compact', digits: 1 },
    { key: `${prefix}iv`, label: `${label} IV`, format: 'pct', digits: 1 },
    { key: `${prefix}delta`, label: `${label} Δ`, format: 'num', digits: 2 },
  ];
  const cells = (prefix: string, q: OptionQuote | undefined): Row => ({
    [`${prefix}bid`]: q?.bid,
    [`${prefix}ask`]: q?.ask,
    [`${prefix}last`]: q?.last,
    [`${prefix}vol`]: q?.volume,
    [`${prefix}oi`]: q?.oi,
    [`${prefix}iv`]: pct(q?.iv),
    [`${prefix}delta`]: q?.delta,
  });
  const rows: Row[] = strikesAround(s.quotes, atm, 12).map((k) => ({
    strike: k,
    ...cells('c', by.get(`C${k}`)),
    ...cells('p', by.get(`P${k}`)),
  }));
  return [
    {
      kind: 'stats',
      items: [
        { label: s.chain.multiplier === 1 ? 'Index' : 'Underlying', value: s.chain.spot, format: 'num', digits: 2 },
        { label: 'Expiry', value: s.expiry },
        { label: 'Days to expiry', value: s.days, format: 'int' },
        { label: 'ATM strike', value: atm, format: 'num', digits: 2 },
        { label: 'ATM implied vol', value: pct(atmIv(s.chain, s.expiry)), format: 'pct', digits: 1 },
        { label: 'Expiries listed', value: s.chain.expiries.length, format: 'int' },
      ],
    },
    {
      kind: 'table',
      title: `${s.chain.symbol} ${s.expiry}: calls (C) and puts (P)`,
      columns: [{ key: 'strike', label: 'Strike', format: 'num', digits }, ...side('c', 'C'), ...side('p', 'P')],
      rows,
      footnote: `Other expiries: ${s.chain.expiries.filter((e) => e !== s.expiry).slice(0, 12).join(', ')}`,
    },
  ];
}

const statsCard: CardDef = {
  id: 'derivatives.options-stats',
  title: 'Option Activity by Expiry',
  source: 'Nasdaq',
  description: 'Put/call volume and open-interest ratios, and total volume and open interest by expiry.',
  params: [SYMBOL_PARAM, EXPIRY_PARAM],
  async run(ctx, params) {
    const s = await setup(ctx, params);
    return finish(s.chain, statsBlocks(s, ctx.now()));
  },
};

/** Put/call ratios, and volume and open interest by expiry. */
export function statsBlocks(s: Setup, now: Date): Block[] {
  const calls = s.chain.quotes.filter((q) => q.type === 'C');
  const puts = s.chain.quotes.filter((q) => q.type === 'P');
  const vol = (q: OptionQuote): number | null => q.volume;
  const oi = (q: OptionQuote): number | null => q.oi;
  const rows: Row[] = s.chain.expiries.map((e) => {
    const c = calls.filter((q) => q.expiry === e);
    const p = puts.filter((q) => q.expiry === e);
    return {
      expiry: e,
      days: daysTo(e, now),
      callVol: sum(c, vol),
      putVol: sum(p, vol),
      pcVol: ratio(sum(p, vol), sum(c, vol)),
      callOi: sum(c, oi),
      putOi: sum(p, oi),
      pcOi: ratio(sum(p, oi), sum(c, oi)),
      totalOi: sum(c, oi) + sum(p, oi),
      totalVol: sum(c, vol) + sum(p, vol),
    };
  });
  const sel = rows.find((r) => r.expiry === s.expiry);
  const shown = rows.slice(0, 24);
  const categories = shown.map((r) => String(r.expiry).slice(2));
  return [
    {
      kind: 'stats',
      title: `${s.chain.symbol}: all expiries`,
      items: [
        { label: 'Put/call volume', value: ratio(sum(puts, vol), sum(calls, vol)), format: 'num', digits: 2 },
        { label: 'Put/call open interest', value: ratio(sum(puts, oi), sum(calls, oi)), format: 'num', digits: 2 },
        { label: 'Total volume', value: sum(calls, vol) + sum(puts, vol), format: 'compact' },
        { label: 'Total open interest', value: sum(calls, oi) + sum(puts, oi), format: 'compact' },
        { label: `P/C volume, ${s.expiry}`, value: sel?.pcVol, format: 'num', digits: 2 },
        { label: `P/C open interest, ${s.expiry}`, value: sel?.pcOi, format: 'num', digits: 2 },
      ],
    },
    {
      kind: 'chart',
      title: 'Open interest by expiry',
      xType: 'category',
      categories,
      style: 'bar',
      yFormat: 'compact',
      series: [{ name: 'Open interest', points: shown.map((r, i) => [i, r.totalOi as number]) }],
    },
    {
      kind: 'chart',
      title: 'Volume by expiry',
      xType: 'category',
      categories,
      style: 'bar',
      yFormat: 'compact',
      series: [{ name: 'Volume', points: shown.map((r, i) => [i, r.totalVol as number]) }],
    },
    {
      kind: 'table',
      columns: [
        { key: 'expiry', label: 'Expiry' },
        { key: 'days', label: 'Days', format: 'int' },
        { key: 'callVol', label: 'Call vol', format: 'compact', digits: 1 },
        { key: 'putVol', label: 'Put vol', format: 'compact', digits: 1 },
        { key: 'pcVol', label: 'P/C vol', format: 'num', digits: 2 },
        { key: 'callOi', label: 'Call OI', format: 'compact', digits: 1 },
        { key: 'putOi', label: 'Put OI', format: 'compact', digits: 1 },
        { key: 'pcOi', label: 'P/C OI', format: 'num', digits: 2 },
      ],
      rows: shown,
    },
  ];
}

const oiStrikeCard: CardDef = {
  id: 'derivatives.options-oi-strike',
  title: 'Open Interest by Strike',
  source: 'Nasdaq',
  description: 'Call and put open interest and volume at each strike for one expiry.',
  params: [SYMBOL_PARAM, EXPIRY_PARAM],
  async run(ctx, params) {
    const s = await setup(ctx, params);
    const atm = atmStrike(s.chain, s.expiry);
    const by = new Map<number, Row>();
    for (const q of s.quotes) {
      const r = by.get(q.strike) ?? { strike: q.strike, callOi: 0, putOi: 0, callVol: 0, putVol: 0, total: 0 };
      if (q.type === 'C') {
        r.callOi = q.oi ?? 0;
        r.callVol = q.volume ?? 0;
      } else {
        r.putOi = q.oi ?? 0;
        r.putVol = q.volume ?? 0;
      }
      r.total = (r.callOi as number) + (r.putOi as number);
      by.set(q.strike, r);
    }
    const keep = new Set(strikesAround(s.quotes, atm, 20));
    const rows = [...by.values()].filter((r) => keep.has(r.strike as number)).sort((a, b) => (a.strike as number) - (b.strike as number));
    return finish(s.chain, [
      {
        kind: 'chart',
        title: `${s.chain.symbol} ${s.expiry}: open interest by strike (underlying ${s.ref.toFixed(2)})`,
        xType: 'number',
        xLabel: 'Strike',
        yFormat: 'compact',
        series: [
          { name: 'Calls', points: rows.map((r) => [r.strike as number, r.callOi as number]) },
          { name: 'Puts', points: rows.map((r) => [r.strike as number, r.putOi as number]) },
        ],
      },
      {
        kind: 'table',
        columns: [
          { key: 'strike', label: 'Strike', format: 'num', digits: 2 },
          { key: 'callOi', label: 'Call OI', format: 'int' },
          { key: 'putOi', label: 'Put OI', format: 'int' },
          { key: 'total', label: 'Total OI', format: 'int' },
          { key: 'callVol', label: 'Call vol', format: 'int' },
          { key: 'putVol', label: 'Put vol', format: 'int' },
        ],
        rows,
      },
    ]);
  },
};

const termCard: CardDef = {
  id: 'derivatives.options-term-structure',
  title: 'Implied Volatility Term Structure',
  source: 'Nasdaq',
  description: 'At-the-money implied volatility for each expiry against days to expiry.',
  params: [SYMBOL_PARAM],
  async run(ctx, params) {
    const chain = await loadChain(ctx, params.symbol ?? 'AAPL');
    const now = ctx.now();
    const rows: Row[] = [];
    for (const e of chain.expiries) {
      const iv = atmIv(chain, e);
      const days = daysTo(e, now);
      if (iv === null || days < 1) continue;
      rows.push({ expiry: e, days, atm: atmStrike(chain, e), iv: iv * 100, move: iv * Math.sqrt(days / 365) * 100 });
    }
    return finish(chain, [
      {
        kind: 'chart',
        title: `${chain.symbol}: at-the-money implied volatility by days to expiry`,
        xType: 'number',
        xLabel: 'Days to expiry',
        yFormat: 'pct',
        yDigits: 1,
        series: [{ name: 'ATM IV', points: rows.map((r) => [r.days as number, r.iv as number]) }],
      },
      {
        kind: 'table',
        columns: [
          { key: 'expiry', label: 'Expiry' },
          { key: 'days', label: 'Days', format: 'int' },
          { key: 'atm', label: 'ATM strike', format: 'num', digits: 2 },
          { key: 'iv', label: 'ATM IV', format: 'pct', digits: 1 },
          { key: 'move', label: '1-sd move to expiry', format: 'pct', digits: 1 },
        ],
        rows,
        footnote: 'ATM IV is the average of the call and put implied vols at the strike nearest the underlying. The 1-sd move is IV scaled by the square root of time.',
      },
    ]);
  },
};

const smileCard: CardDef = {
  id: 'derivatives.options-smile',
  title: 'Volatility Smile',
  source: 'Nasdaq',
  description: 'Implied volatility of out-of-the-money options by strike for one expiry.',
  params: [SYMBOL_PARAM, EXPIRY_PARAM],
  async run(ctx, params) {
    const s = await setup(ctx, params);
    const all = otmSmile(s.chain, s.expiry).filter((p) => p.strike >= s.ref * 0.6 && p.strike <= s.ref * 1.5);
    const atm = atmStrike(s.chain, s.expiry);
    const near = new Set([...all].sort((a, b) => Math.abs(a.strike - s.ref) - Math.abs(b.strike - s.ref)).slice(0, 30).map((p) => p.strike));
    return finish(s.chain, [
      {
        kind: 'chart',
        title: `${s.chain.symbol} ${s.expiry} (${s.days} days): out-of-the-money implied volatility by strike`,
        xType: 'number',
        xLabel: 'Strike',
        yFormat: 'pct',
        yDigits: 1,
        series: [{ name: 'OTM IV', points: all.map((p) => [p.strike, p.iv * 100]) }],
      },
      {
        kind: 'table',
        columns: [
          { key: 'strike', label: 'Strike', format: 'num', digits: 2 },
          { key: 'money', label: 'Strike / underlying', format: 'pct', digits: 1 },
          { key: 'side', label: 'Option' },
          { key: 'iv', label: 'IV', format: 'pct', digits: 1 },
        ],
        rows: all
          .filter((p) => near.has(p.strike))
          .map((p) => ({ strike: p.strike, money: (p.strike / s.ref) * 100, side: p.type === 'C' ? 'call' : 'put', iv: p.iv * 100 })),
        footnote: `Puts below the underlying (${s.ref.toFixed(2)}), calls at and above it. ATM strike ${atm ?? 'n/a'}.`,
      },
    ]);
  },
};

export const MONEYNESS = [80, 85, 90, 95, 97.5, 100, 102.5, 105, 110, 115, 120];

/** OTM implied vol (percent) at the listed strike nearest each moneyness level; null where nothing is within 1.5% of it. */
export function surfaceRow(chain: Chain, expiry: string, levels: number[] = MONEYNESS): (number | null)[] {
  const ref = underlyingFor(chain, expiry);
  const smile = otmSmile(chain, expiry);
  return levels.map((m) => {
    const target = (ref * m) / 100;
    let best: { strike: number; iv: number } | null = null;
    for (const p of smile) if (!best || Math.abs(p.strike - target) < Math.abs(best.strike - target)) best = p;
    return best && Math.abs(best.strike / target - 1) <= 0.015 ? best.iv * 100 : null;
  });
}

/** Up to `max` expiries for a matrix: the first few listed, then monthlies. */
export function surfaceExpiries(chain: Chain, max = 12): string[] {
  const monthly = new Set(monthlyExpiries(chain));
  const out = chain.expiries.filter((e, i) => i < 3 || monthly.has(e));
  return out.slice(0, max);
}

const surfaceCard: CardDef = {
  id: 'derivatives.options-surface',
  title: 'Volatility Surface',
  source: 'Nasdaq',
  description: 'Implied volatility by moneyness (strike as a percent of the underlying) and expiry, as a matrix.',
  params: [SYMBOL_PARAM],
  async run(ctx, params) {
    const chain = await loadChain(ctx, params.symbol ?? 'AAPL');
    return finish(chain, surfaceBlocks(chain, ctx.now()));
  },
};

/** The implied-volatility matrix: expiries down, moneyness across. */
export function surfaceBlocks(chain: Chain, now: Date): Block[] {
  const rows: Row[] = [];
  for (const e of surfaceExpiries(chain)) {
    const ivs = surfaceRow(chain, e);
    if (ivs.every((v) => v === null)) continue;
    const row: Row = { expiry: e, days: daysTo(e, now) };
    MONEYNESS.forEach((m, i) => (row[`m${m}`] = ivs[i]));
    rows.push(row);
  }
  return [
    {
      kind: 'table',
      title: `${chain.symbol}: implied volatility (%) by strike / underlying and expiry`,
      columns: [
        { key: 'expiry', label: 'Expiry' },
        { key: 'days', label: 'Days', format: 'int' },
        ...MONEYNESS.map((m): Column => ({ key: `m${m}`, label: `${m}%`, format: 'num', digits: 1 })),
      ],
      rows,
      footnote: 'Out-of-the-money options: puts below 100%, calls at and above. A blank cell means no listed strike with an implied volatility within 1.5% of that level.',
    },
  ];
}

export const optionCards: CardDef[] = [chainCard, statsCard, oiStrikeCard, termCard, smileCard, surfaceCard];
