/**
 * Technical analysis: automated trendlines, support and resistance,
 * Fibonacci retracements, candlestick and chart patterns, and a summary that
 * scores them together. Works on any symbol the shared market data can price
 * (stocks, ETFs, indices, currency pairs, futures, crypto).
 *
 * The cards compute; they never trade. Overlays are extra chart series (a
 * trendline is a series along the line), so every surface draws them with no
 * renderer changes.
 */
import { SourceError, type AreaModule, type Block, type CardDef, type CardResult, type Ctx, type DashboardDef, type ParamSpec, type Row, type Series } from '../../types.js';
import { getHistory, type Bar, type History, type Range } from '../../lib/market.js';
import { fibonacci, levels, lineAt, macd, pivots, rsi, smaLast, trendlines, type Bias, type Level, type Trendline } from './analysis.js';
import { candlestickPatterns } from './candles.js';
import { chartPatterns, type ChartPattern } from './patterns.js';

export const TA_SOURCE = 'b1dz technicals';
const TA_RANGES = ['3M', '6M', '1Y', '2Y', '5Y'];
const SYMBOL: ParamSpec = { name: 'symbol', label: 'Symbol', default: 'AAPL', hint: 'any ticker: AAPL, SPY, ^GSPC, BTC-USD, EURUSD=X, CL=F' };
const RANGE: ParamSpec = { name: 'range', label: 'Range', default: '1Y', choices: TA_RANGES };
const PARAMS = [SYMBOL, RANGE];
const MIN_BARS = 30;

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Daily bars for the card. A bare coin (BTC) that does not price as a stock is retried as BTC-USD. */
export async function taHistory(ctx: Ctx, params: Record<string, string>): Promise<History & { range: Range }> {
  const symbol = (params.symbol || 'AAPL').trim().toUpperCase();
  const range = (TA_RANGES.includes(params.range) ? params.range : '1Y') as Range;
  let h: History;
  try {
    h = await getHistory(ctx, symbol, range);
  } catch (err) {
    if (!/^[A-Z0-9]{2,6}$/.test(symbol)) throw err;
    h = await getHistory(ctx, `${symbol}-USD`, range).catch(() => {
      throw err;
    });
  }
  const bars = h.bars.filter((b) => [b.o, b.h, b.l, b.c].every(Number.isFinite) && b.h >= b.l);
  if (bars.length < MIN_BARS) throw new SourceError(h.source, `only ${bars.length} daily bars for ${h.symbol}; technical analysis needs at least ${MIN_BARS}`);
  return { ...h, bars, range };
}

function base(h: History, blocks: Block[], notes: string[]): CardResult {
  return {
    blocks,
    source: `${h.source}, analysed by b1dz`,
    asOf: ymd(h.bars[h.bars.length - 1].t),
    notes: [...notes, 'Computed from daily bars by fixed rules; patterns are probabilities, not signals to trade. Research only.'],
  };
}

const closeSeries = (h: History): Series => ({ name: `${h.symbol} close`, points: h.bars.map((b) => [b.t, b.c]) });

/** A straight line from bar `from` to bar `to` as a series, one point per bar so it stays straight on a time axis. */
export function lineSeries(name: string, bars: Bar[], a: { i: number; price: number }, b: { i: number; price: number }, from = a.i, to = bars.length - 1): Series {
  const pts: [number, number][] = [];
  if (a.i === b.i) return { name, points: [[bars[from].t, a.price], [bars[to].t, a.price]] };
  for (let i = Math.max(0, from); i <= Math.min(to, bars.length - 1); i++) pts.push([bars[i].t, lineAt(a, b, i)]);
  return { name, points: pts };
}

const flat = (name: string, bars: Bar[], price: number): Series => ({ name, points: [[bars[0].t, price], [bars[bars.length - 1].t, price]] });
const fmt = (x: number) => (Math.abs(x) >= 1000 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(2) : x.toPrecision(4));

/** The two levels nearest the price on each side. */
function nearLevels(lv: Level[]): Level[] {
  const sup = lv.filter((l) => l.kind === 'support').sort((a, b) => b.price - a.price).slice(0, 2);
  const res = lv.filter((l) => l.kind === 'resistance').sort((a, b) => a.price - b.price).slice(0, 2);
  return [...res.reverse(), ...sup];
}

// ------------------------------------------------------------ cards

const trendCard: CardDef = {
  id: 'technicals.trendlines',
  title: 'Auto trendlines and levels',
  source: TA_SOURCE,
  description: 'Automatically drawn support and resistance trendlines through swing points, plus horizontal support and resistance levels, overlaid on the daily closes, with touches, slope and whether price is holding, testing or breaking each line.',
  params: PARAMS,
  async run(ctx, params) {
    const h = await taHistory(ctx, params);
    const bars = h.bars;
    const piv = pivots(bars);
    const lines = trendlines(bars, piv);
    const lv = levels(bars, piv);
    const series: Series[] = [closeSeries(h)];
    for (const l of lines) series.push(lineSeries(l.kind === 'support' ? 'Support trend' : 'Resistance trend', bars, l.a, l.b));
    const near = nearLevels(lv);
    const rank = (l: Level) => near.filter((x) => x.kind === l.kind && Math.abs(x.price - bars[bars.length - 1].c) <= Math.abs(l.price - bars[bars.length - 1].c)).length;
    for (const l of near) series.push(flat(`${l.kind === 'support' ? 'S' : 'R'}${rank(l)}`, bars, l.price));
    const lineRows: Row[] = lines.map((l: Trendline) => ({
      line: l.kind === 'support' ? 'Support trendline' : 'Resistance trendline',
      from: l.a.t,
      anchor: l.b.t,
      touches: l.touches,
      slope: l.slopePctPerDay,
      now: l.valueNow,
      dist: ((l.valueNow - bars[bars.length - 1].c) / bars[bars.length - 1].c) * 100,
      status: l.status === 'broken' ? (l.kind === 'support' ? 'broken (breakdown)' : 'broken (breakout)') : l.status,
    }));
    const levelRows: Row[] = lv.map((l) => ({ level: l.price, kind: l.kind, touches: l.touches, last: l.lastT, dist: l.distancePct }));
    return base(
      h,
      [
        { kind: 'chart', title: `${h.symbol} with auto trendlines and levels, ${h.range}`, xType: 'time', series, yFormat: 'num' },
        {
          kind: 'table',
          title: 'Trendlines',
          columns: [
            { key: 'line', label: 'Line' },
            { key: 'from', label: 'From', format: 'date' },
            { key: 'anchor', label: 'Second swing', format: 'date' },
            { key: 'touches', label: 'Touches', format: 'int' },
            { key: 'slope', label: 'Slope %/day', format: 'signed', digits: 3 },
            { key: 'now', label: 'Line now', format: 'num' },
            { key: 'dist', label: 'From price', format: 'signedPct', digits: 1 },
            { key: 'status', label: 'Status' },
          ],
          rows: lineRows,
          footnote: lineRows.length ? undefined : 'No trendline has held through two swings in this window.',
        },
        {
          kind: 'table',
          title: 'Support and resistance levels',
          columns: [
            { key: 'level', label: 'Level', format: 'num' },
            { key: 'kind', label: 'Type' },
            { key: 'touches', label: 'Touches', format: 'int' },
            { key: 'last', label: 'Last touch', format: 'date' },
            { key: 'dist', label: 'From price', format: 'signedPct', digits: 1 },
          ],
          rows: levelRows,
        },
      ],
      ['Swings are bars that out-reach their neighbours; a trendline must not be closed through (by more than half an ATR) from its first swing to three bars ago. Levels cluster swing highs and lows within half an ATR.'],
    );
  },
};

const fibCard: CardDef = {
  id: 'technicals.fibonacci',
  title: 'Fibonacci retracement',
  source: TA_SOURCE,
  description: "Fibonacci retracement and extension levels of the window's dominant swing (lowest low to highest high), overlaid on the daily closes, with the level nearest the price.",
  params: PARAMS,
  async run(ctx, params) {
    const h = await taHistory(ctx, params);
    const bars = h.bars;
    const f = fibonacci(bars);
    if (!f) throw new SourceError(h.source, `no price range for ${h.symbol}`);
    const last = bars[bars.length - 1].c;
    const retr = f.levels.filter((l) => l.kind === 'retracement');
    const series: Series[] = [closeSeries(h), ...retr.map((l) => flat(`Fib ${(l.ratio * 100).toFixed(1)}%`, bars, l.price))];
    return base(
      h,
      [
        { kind: 'chart', title: `${h.symbol} Fibonacci retracement, ${h.range}`, xType: 'time', series, yFormat: 'num' },
        {
          kind: 'stats',
          items: [
            { label: 'Swing', value: f.direction === 'up' ? 'rally (low first)' : 'decline (high first)' },
            { label: 'Swing low', value: f.low.price, format: 'num' },
            { label: 'Low date', value: f.low.t, format: 'date' },
            { label: 'Swing high', value: f.high.price, format: 'num' },
            { label: 'High date', value: f.high.t, format: 'date' },
            { label: 'Last close', value: last, format: 'num' },
            { label: 'Nearest level', value: `${(f.nearest.ratio * 100).toFixed(1)}% at ${fmt(f.nearest.price)}` },
          ],
        },
        {
          kind: 'table',
          title: 'Levels',
          columns: [
            { key: 'ratio', label: 'Ratio', format: 'pct', digits: 1 },
            { key: 'kind', label: 'Type' },
            { key: 'price', label: 'Price', format: 'num' },
            { key: 'dist', label: 'From price', format: 'signedPct', digits: 1 },
          ],
          rows: f.levels.map((l) => ({ ratio: l.ratio * 100, kind: l.kind, price: l.price, dist: ((l.price - last) / last) * 100 })),
        },
      ],
      [f.direction === 'up' ? 'A rally: retracements are measured down from the high, extensions project above it.' : 'A decline: retracements are measured up from the low, extensions project below it.'],
    );
  },
};

const candleCard: CardDef = {
  id: 'technicals.candlesticks',
  title: 'Candlestick patterns',
  source: TA_SOURCE,
  description: 'Candlestick patterns detected in the last 30 daily bars (hammer, shooting star, engulfing, harami, piercing line, dark cloud, morning and evening star, three soldiers or crows, doji, marubozu), each with its bullish or bearish bias.',
  params: PARAMS,
  async run(ctx, params) {
    const h = await taHistory(ctx, params);
    const hits = candlestickPatterns(h.bars, 30);
    const count = (b: Bias) => hits.filter((x) => x.bias === b).length;
    return base(
      h,
      [
        {
          kind: 'stats',
          title: 'Last 30 bars',
          items: [
            { label: 'Bullish patterns', value: count('bullish'), format: 'int' },
            { label: 'Bearish patterns', value: count('bearish'), format: 'int' },
            { label: 'Neutral (doji)', value: count('neutral'), format: 'int' },
            { label: 'Latest', value: hits[0] ? `${hits[0].pattern} (${ymd(hits[0].t)})` : 'none' },
          ],
        },
        {
          kind: 'table',
          title: 'Patterns, newest first',
          columns: [
            { key: 'date', label: 'Date', format: 'date' },
            { key: 'pattern', label: 'Pattern' },
            { key: 'bias', label: 'Bias' },
            { key: 'bars', label: 'Bars', format: 'int' },
            { key: 'close', label: 'Close', format: 'num' },
          ],
          rows: hits.map((x) => ({ date: x.t, pattern: x.pattern, bias: x.bias, bars: x.bars, close: h.bars[x.i].c })),
          footnote: hits.length ? undefined : 'No pattern completed in the last 30 bars.',
        },
      ],
      ['Reversal patterns need the trend they reverse (a close five bars back at least one ATR away), so the same shape can be a hammer after a decline and a hanging man after a rally.'],
    );
  },
};

function patternSeries(bars: Bar[], p: ChartPattern): Series[] {
  return p.lines.map((l) => lineSeries(`${p.pattern}: ${l.name}`, bars, l.from, l.to, l.from.i, l.to.i));
}

const patternCard: CardDef = {
  id: 'technicals.patterns',
  title: 'Pattern recognition',
  source: TA_SOURCE,
  description: 'Classic chart patterns found automatically from swing points: head and shoulders (and inverse), double tops and bottoms, ascending, descending and symmetrical triangles, rising and falling wedges, channels and ranges, with status, trigger line and measured-move target.',
  params: PARAMS,
  async run(ctx, params) {
    const h = await taHistory(ctx, params);
    const bars = h.bars;
    const found = chartPatterns(bars);
    const series: Series[] = [closeSeries(h), ...found.slice(0, 2).flatMap((p) => patternSeries(bars, p))];
    const last = bars[bars.length - 1].c;
    return base(
      h,
      [
        { kind: 'chart', title: `${h.symbol} patterns, ${h.range}`, xType: 'time', series, yFormat: 'num' },
        {
          kind: 'table',
          title: 'Patterns, most recent first',
          columns: [
            { key: 'pattern', label: 'Pattern' },
            { key: 'bias', label: 'Bias' },
            { key: 'status', label: 'Status' },
            { key: 'start', label: 'From', format: 'date' },
            { key: 'end', label: 'To', format: 'date' },
            { key: 'trigger', label: 'Trigger now', format: 'num' },
            { key: 'target', label: 'Target', format: 'num' },
            { key: 'upside', label: 'Target vs price', format: 'signedPct', digits: 1 },
          ],
          rows: found.map((p) => ({
            pattern: p.pattern,
            bias: p.bias,
            status: p.status === 'confirmed' && p.target !== null && (p.bias === 'bearish' ? last <= p.target : p.bias === 'bullish' ? last >= p.target : false) ? 'target reached' : p.status,
            start: bars[p.startI].t,
            end: bars[p.endI].t,
            trigger: p.trigger,
            target: p.target,
            upside: p.target === null ? null : ((p.target - last) / last) * 100,
          })),
          footnote: found.length ? undefined : 'No classic pattern completed in the second half of this window. Try a longer range.',
        },
      ],
      ['Confirmed means a close through the trigger (neckline or boundary); the target is the measured move (pattern height projected from the trigger). Only patterns finishing in the second half of the window are listed.'],
    );
  },
};

export interface Signal {
  signal: string;
  reading: string;
  bias: Bias;
}

/** Every rule's verdict on the bars, for the summary card and the analyst. */
export function technicalSignals(bars: Bar[]): { signals: Signal[]; score: number } {
  const closes = bars.map((b) => b.c);
  const c = closes[closes.length - 1];
  const out: Signal[] = [];
  const sma50 = smaLast(closes, 50);
  const sma200 = smaLast(closes, 200);
  if (sma50 !== null) out.push({ signal: 'Price vs 50-day average', reading: `${c >= sma50 ? 'above' : 'below'} ${fmt(sma50)}`, bias: c >= sma50 ? 'bullish' : 'bearish' });
  if (sma200 !== null) out.push({ signal: 'Price vs 200-day average', reading: `${c >= sma200 ? 'above' : 'below'} ${fmt(sma200)}`, bias: c >= sma200 ? 'bullish' : 'bearish' });
  if (sma50 !== null && sma200 !== null) out.push({ signal: '50 vs 200-day average', reading: sma50 >= sma200 ? 'golden cross regime' : 'death cross regime', bias: sma50 >= sma200 ? 'bullish' : 'bearish' });
  const r = rsi(closes);
  if (r !== null) out.push({ signal: 'RSI (14)', reading: `${r.toFixed(0)}${r >= 70 ? ' overbought' : r <= 30 ? ' oversold' : ''}`, bias: r >= 70 ? 'bearish' : r <= 30 ? 'bullish' : r >= 50 ? 'bullish' : 'bearish' });
  const m = macd(closes);
  if (m) out.push({ signal: 'MACD (12, 26, 9)', reading: `histogram ${m.hist >= 0 ? '+' : ''}${fmt(m.hist)}`, bias: m.hist >= 0 ? 'bullish' : 'bearish' });
  const piv = pivots(bars);
  for (const l of trendlines(bars, piv)) {
    const broke = l.status === 'broken';
    out.push({
      signal: l.kind === 'support' ? 'Support trendline' : 'Resistance trendline',
      reading: `${broke ? (l.kind === 'support' ? 'broken down' : 'broken out') : l.status} at ${fmt(l.valueNow)}, ${l.touches} touches`,
      bias: l.kind === 'support' ? (broke ? 'bearish' : 'bullish') : broke ? 'bullish' : 'neutral',
    });
  }
  const lv = levels(bars, piv);
  const sup = lv.filter((l) => l.kind === 'support').sort((a, b) => b.price - a.price)[0];
  const res = lv.filter((l) => l.kind === 'resistance').sort((a, b) => a.price - b.price)[0];
  if (sup) out.push({ signal: 'Nearest support', reading: `${fmt(sup.price)} (${sup.distancePct.toFixed(1)}%)`, bias: 'neutral' });
  if (res) out.push({ signal: 'Nearest resistance', reading: `${fmt(res.price)} (+${res.distancePct.toFixed(1)}%)`, bias: 'neutral' });
  const candle = candlestickPatterns(bars, 5)[0];
  if (candle) out.push({ signal: 'Latest candlestick (5 bars)', reading: `${candle.pattern}, ${ymd(candle.t)}`, bias: candle.bias });
  for (const p of chartPatterns(bars, piv).filter((x) => x.status !== 'failed').slice(0, 2)) {
    out.push({ signal: 'Chart pattern', reading: `${p.pattern} (${p.status})`, bias: p.bias });
  }
  const score = out.reduce((s, x) => s + (x.bias === 'bullish' ? 1 : x.bias === 'bearish' ? -1 : 0), 0);
  return { signals: out, score };
}

const summaryCard: CardDef = {
  id: 'technicals.summary',
  title: 'Technical summary',
  source: TA_SOURCE,
  description: 'One-screen technical read: trend versus the 50 and 200-day averages, RSI, MACD, auto trendline status, nearest support and resistance, latest candlestick and chart patterns, and a net bullish or bearish score.',
  params: PARAMS,
  async run(ctx, params) {
    const h = await taHistory(ctx, params);
    const { signals, score } = technicalSignals(h.bars);
    const bulls = signals.filter((s) => s.bias === 'bullish').length;
    const bears = signals.filter((s) => s.bias === 'bearish').length;
    const verdict = score >= 3 ? 'Bullish' : score >= 1 ? 'Leaning bullish' : score <= -3 ? 'Bearish' : score <= -1 ? 'Leaning bearish' : 'Neutral';
    return base(
      h,
      [
        {
          kind: 'stats',
          title: `${h.symbol} technicals, ${h.range}`,
          items: [
            { label: 'Verdict', value: verdict },
            { label: 'Net score', value: score, format: 'signed', digits: 0 },
            { label: 'Bullish signals', value: bulls, format: 'int' },
            { label: 'Bearish signals', value: bears, format: 'int' },
            { label: 'Last close', value: h.bars[h.bars.length - 1].c, format: 'num' },
          ],
        },
        {
          kind: 'table',
          title: 'Signals',
          columns: [
            { key: 'signal', label: 'Signal' },
            { key: 'reading', label: 'Reading', maxWidth: 40 },
            { key: 'bias', label: 'Bias' },
          ],
          rows: signals.map((s) => ({ ...s })),
        },
      ],
      ['Each signal counts +1 bullish, -1 bearish, 0 neutral. The 200-day average needs a 1Y or longer range.'],
    );
  },
};

/**
 * The Coin dashboard's input is a coin (BTC), and a bare BTC is also a U.S.
 * ETF ticker. These copies always read it as the coin's dollar pair.
 */
function coinVariant(card: CardDef, id: string): CardDef {
  return {
    ...card,
    id,
    params: [{ name: 'symbol', label: 'Coin', default: 'BTC-USD', hint: 'coin or pair, e.g. BTC, ETH-USD, SOL' }, RANGE],
    run: (ctx, params) => card.run(ctx, { ...params, symbol: coinPair(params.symbol) }),
  };
}

/** BTC, btc-usd, ETH/USDT, XBT to the dollar pair the market data prices (BTC-USD). */
export function coinPair(input: string | undefined): string {
  const s = (input || 'BTC-USD').trim().toUpperCase();
  const m = /^([A-Z0-9]{2,10})(?:[-/_:]?(USD|USDT|USDC|EUR|GBP|BTC|ETH))?$/.exec(s);
  if (!m) return s;
  const coin = m[1] === 'XBT' ? 'BTC' : m[1];
  return `${coin}-${m[2] ?? 'USD'}`;
}

export const coinTechnicalCards: CardDef[] = [
  coinVariant(summaryCard, 'crypto.technical-summary'),
  coinVariant(trendCard, 'crypto.trendlines'),
  coinVariant(patternCard, 'crypto.patterns'),
];

export const technicalCards: CardDef[] = [summaryCard, trendCard, patternCard, candleCard, fibCard, ...coinTechnicalCards];

const dashboards: DashboardDef[] = [
  {
    id: 'technicals',
    title: 'Technical Analysis',
    group: 'Technicals',
    tabs: [
      { id: 'overview', title: 'Summary', cards: ['technicals.summary', 'technicals.trendlines'] },
      { id: 'patterns', title: 'Patterns', cards: ['technicals.patterns', 'technicals.candlesticks'] },
      { id: 'fibonacci', title: 'Fibonacci', cards: ['technicals.fibonacci'] },
    ],
  },
];

export const technicals: AreaModule = { cards: technicalCards, dashboards };
