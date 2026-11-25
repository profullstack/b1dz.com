/**
 * Futures boards and forward curves through the shared market library
 * (lib/market). Futures quotes come from Yahoo Finance, which refuses some
 * networks (data centres); where it does not answer these cards say so
 * rather than show anything else.
 */
import { CDE_NOTE, futuresNotes } from '../../lib/exchange-futures.js';
import { getQuotes, returnsBoard } from '../../lib/market.js';
import { SourceError, type CardDef, type Row } from '../../types.js';

const MONTH_CODES = 'FGHJKMNQUVXZ';

export interface FuturesRoot {
  root: string;
  name: string;
  /** Exchange suffix in the symbol convention: NYM, CMX, CBT, CME, NYB. */
  exchange: string;
  /** Listed delivery months, as month codes (F = January ... Z = December). */
  months: string;
  unit: string;
}

export const ROOTS: Record<string, FuturesRoot> = {
  CL: { root: 'CL', name: 'WTI crude oil', exchange: 'NYM', months: MONTH_CODES, unit: 'USD/bbl' },
  NG: { root: 'NG', name: 'Henry Hub natural gas', exchange: 'NYM', months: MONTH_CODES, unit: 'USD/MMBtu' },
  GC: { root: 'GC', name: 'Gold', exchange: 'CMX', months: 'GJMQVZ', unit: 'USD/oz' },
  HG: { root: 'HG', name: 'Copper', exchange: 'CMX', months: 'HKNUZ', unit: 'USD/lb' },
  ZC: { root: 'ZC', name: 'Corn', exchange: 'CBT', months: 'HKNUZ', unit: 'US cents/bu' },
  ZW: { root: 'ZW', name: 'Wheat (Chicago SRW)', exchange: 'CBT', months: 'HKNUZ', unit: 'US cents/bu' },
  ZS: { root: 'ZS', name: 'Soybeans', exchange: 'CBT', months: 'FHKNQUX', unit: 'US cents/bu' },
};

export interface Contract {
  symbol: string;
  /** "Dec 2026". */
  label: string;
  /** First day of the delivery month, ms epoch. */
  month: number;
}

/** The next `count` listed contracts after the month of `now` (the spot month is skipped: it is usually in delivery). */
export function contractChain(root: FuturesRoot, now: Date, count: number): Contract[] {
  const out: Contract[] = [];
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1;
  for (let guard = 0; out.length < count && guard < 240; guard++, m++) {
    if (m > 11) {
      m = 0;
      y++;
    }
    const code = MONTH_CODES[m];
    if (!root.months.includes(code)) continue;
    const t = Date.UTC(y, m, 1);
    out.push({
      symbol: `${root.root}${code}${String(y % 100).padStart(2, '0')}.${root.exchange}`,
      label: new Date(t).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      month: t,
    });
  }
  return out;
}

export function futuresBoardCard(def: { id: string; title: string; description: string; symbols: { symbol: string; label: string }[] }): CardDef {
  const names = new Map(def.symbols.map((s) => [s.symbol, s.label]));
  return {
    id: def.id,
    title: def.title,
    source: 'Market data',
    description: def.description,
    params: [{ name: 'symbols', label: 'Symbols', default: def.symbols.map((s) => s.symbol).join(','), hint: 'front-month futures, comma separated, e.g. CL=F,GC=F' }],
    async run(ctx, params) {
      const list = (params.symbols ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 30);
      if (!list.length) throw new SourceError('Market data', 'no symbols given');
      const { block, source, notes } = await returnsBoard(ctx, list.map((symbol) => ({ symbol, label: names.get(symbol) ?? symbol })));
      return { blocks: [block], source, notes: [...futuresNotes(source, 'Front-month futures, continuous: returns across a contract roll include the roll gap.'), ...notes] };
    },
  };
}

export function curveCard(def: { id: string; title: string; description: string; roots: string[]; count: number }): CardDef {
  return {
    id: def.id,
    title: def.title,
    source: 'Market data',
    description: def.description,
    params: [{ name: 'symbol', label: 'Contract', default: def.roots[0], choices: def.roots, hint: def.roots.map((r) => `${r} ${ROOTS[r].name}`).join(', ') }],
    async run(ctx, params) {
      const root = ROOTS[(params.symbol ?? '').trim().toUpperCase()] ?? ROOTS[def.roots[0]];
      const chain = contractChain(root, ctx.now(), def.count);
      const quotes = await getQuotes(ctx, chain.map((c) => c.symbol));
      const priced = chain.map((c, i) => ({ c, q: quotes[i] })).filter((x): x is { c: Contract; q: (typeof quotes)[number] & { price: number } } => x.q.price !== null);
      if (priced.length < 2) {
        const why = quotes.find((q) => q.price === null)?.source ?? 'no quotes';
        throw new SourceError('Market data', `no dated ${root.root} contracts could be priced from this network (${why})`);
      }
      const front = priced[0];
      const rows: Row[] = priced.map((x) => ({
        contract: x.c.label,
        symbol: x.c.symbol,
        price: x.q.price,
        day: x.q.changePct,
        vsFront: x.q.price - front.q.price,
        vsFrontPct: ((x.q.price - front.q.price) / front.q.price) * 100,
      }));
      const back = priced[priced.length - 1];
      const sources = [...new Set(priced.map((x) => x.q.source))].join(', ');
      return {
        blocks: [
          {
            kind: 'stats',
            items: [
              { label: `Front (${front.c.label})`, value: front.q.price, format: 'num', digits: 2 },
              { label: `Last listed (${back.c.label})`, value: back.q.price, format: 'num', digits: 2 },
              { label: 'Shape', value: back.q.price < front.q.price ? 'Backwardation (later months cheaper)' : 'Contango (later months dearer)' },
            ],
          },
          {
            kind: 'chart',
            title: `${root.name} forward curve, ${root.unit}`,
            xType: 'number',
            xLabel: 'Years to delivery month',
            yFormat: 'num',
            yDigits: 2,
            series: [{ name: root.root, points: priced.map((x) => [(x.c.month - ctx.now().getTime()) / (365.25 * 86_400_000), x.q.price] as [number, number]) }],
          },
          {
            kind: 'table',
            columns: [
              { key: 'contract', label: 'Delivery' },
              { key: 'symbol', label: 'Symbol' },
              { key: 'price', label: 'Price', format: 'num', digits: 2 },
              { key: 'day', label: 'Day', format: 'signedPct' },
              { key: 'vsFront', label: 'vs front', format: 'signed', digits: 2 },
              { key: 'vsFrontPct', label: 'vs front %', format: 'signedPct' },
            ],
            rows,
          },
        ],
        source: sources,
        asOf: front.q.time,
        notes: [`Dated ${root.name} contracts (${root.unit}), delayed quotes. Contracts with no quote are left out.`, ...(sources.includes('Coinbase Derivatives') ? [CDE_NOTE] : [])],
      };
    },
  };
}
