/** Crypto dashboard: Deribit volatility (smile, surface, DVOL vs realised), funding and futures basis. */
import { SourceError, type CardDef, type Row, type Series } from '../../types.js';
import { atmIv, daysTo, loadChain, monthlyExpiries, otmSmile, underlyingFor } from './chain.js';
import { CURRENCY_PARAM, coinOf } from './crypto.js';
import { DERIBIT, dailyCloses, deribit, parseInstrument, type BookSummary } from './deribit.js';
import { rollingRealizedVol } from './optionmath.js';
import { finish, surfaceBlocks } from './options.js';

const DAY = 86_400_000;

const smileCard: CardDef = {
  id: 'derivatives.crypto-smile',
  title: 'Crypto Volatility Smiles',
  source: 'Deribit',
  description: 'Deribit mark implied volatility of out-of-the-money BTC or ETH options by moneyness, one line per expiry.',
  params: [CURRENCY_PARAM],
  async run(ctx, params) {
    const chain = await loadChain(ctx, coinOf(params));
    const now = ctx.now();
    const monthly = monthlyExpiries(chain);
    const live = chain.expiries.filter((e) => daysTo(e, now) >= 1);
    const picks = [...new Set([live[0], ...live.filter((e) => daysTo(e, now) >= 5).slice(0, 1), ...monthly.filter((e) => daysTo(e, now) >= 5)])]
      .filter(Boolean)
      .sort()
      .slice(0, 6);
    const series: Series[] = [];
    const rows: Row[] = [];
    for (const e of picks) {
      const ref = underlyingFor(chain, e);
      const pts = otmSmile(chain, e)
        .map((p): [number, number] => [(p.strike / ref) * 100, p.iv * 100])
        .filter(([m]) => m >= 60 && m <= 160);
      if (pts.length < 3) continue;
      series.push({ name: `${e} (${daysTo(e, now)}d)`, points: pts });
      const at = (m: number): number | null => {
        const best = [...pts].sort((a, b) => Math.abs(a[0] - m) - Math.abs(b[0] - m))[0];
        return Math.abs(best[0] - m) <= 4 ? best[1] : null;
      };
      const p90 = at(90);
      const c110 = at(110);
      rows.push({ expiry: e, days: daysTo(e, now), forward: ref, p80: at(80), p90, atm: (atmIv(chain, e) ?? NaN) * 100 || null, c110, c120: at(120), skew: p90 !== null && c110 !== null ? p90 - c110 : null });
    }
    if (!series.length) throw new SourceError(DERIBIT, `${chain.symbol}: no expiry has enough quoted strikes for a smile`);
    return finish(chain, [
      {
        kind: 'chart',
        title: `${chain.symbol}: out-of-the-money mark IV by strike as % of the forward`,
        xType: 'number',
        xLabel: 'Strike / forward, %',
        yFormat: 'pct',
        yDigits: 0,
        series,
      },
      {
        kind: 'table',
        columns: [
          { key: 'expiry', label: 'Expiry' },
          { key: 'days', label: 'Days', format: 'int' },
          { key: 'forward', label: 'Forward', format: 'num', digits: 0 },
          { key: 'p80', label: '80% put', format: 'pct', digits: 1 },
          { key: 'p90', label: '90% put', format: 'pct', digits: 1 },
          { key: 'atm', label: 'ATM', format: 'pct', digits: 1 },
          { key: 'c110', label: '110% call', format: 'pct', digits: 1 },
          { key: 'c120', label: '120% call', format: 'pct', digits: 1 },
          { key: 'skew', label: '90% put - 110% call', format: 'signed', digits: 1 },
        ],
        rows,
        footnote: 'Each cell is the listed strike nearest that level (within 4 points of moneyness). A positive skew means downside protection is priced richer than upside.',
      },
    ]);
  },
};

const surfaceCard: CardDef = {
  id: 'derivatives.crypto-surface',
  title: 'Crypto Volatility Surface',
  source: 'Deribit',
  description: 'Deribit mark implied volatility for BTC or ETH by moneyness and expiry, as a matrix.',
  params: [CURRENCY_PARAM],
  async run(ctx, params) {
    const chain = await loadChain(ctx, coinOf(params));
    return finish(chain, surfaceBlocks(chain, ctx.now()));
  },
};

const DVOL_RANGE: Record<string, number> = { '3M': 91, '6M': 182, '1Y': 365, '2Y': 730 };

interface VolIndex {
  data?: [number, number, number, number, number][];
}

const dvolCard: CardDef = {
  id: 'derivatives.crypto-dvol',
  title: 'DVOL vs Realised Volatility',
  source: 'Deribit',
  description: 'Deribit\'s 30-day implied volatility index (DVOL) against 30-day realised volatility of the perpetual.',
  params: [CURRENCY_PARAM, { name: 'range', label: 'Range', default: '1Y', choices: Object.keys(DVOL_RANGE) }],
  async run(ctx, params) {
    const coin = coinOf(params);
    const days = DVOL_RANGE[(params.range ?? '1Y').toUpperCase()] ?? 365;
    const end = ctx.now().getTime();
    const start = end - days * DAY;
    const idx = await deribit<VolIndex>(ctx, 'get_volatility_index_data', { currency: coin, start_timestamp: start, end_timestamp: end, resolution: '1D' }, 900);
    const dvol = (idx.data ?? []).map((d): [number, number] => [d[0], d[4]]).sort((a, b) => a[0] - b[0]);
    if (!dvol.length) throw new SourceError(DERIBIT, `no DVOL history for ${coin}`);
    const bars = await dailyCloses(ctx, `${coin}-PERPETUAL`, days + 45);
    const window = 30;
    const roll = rollingRealizedVol(bars.map((b) => b[1]), window, 365);
    const realised = roll.map((v, i): [number, number] => [bars[i + window][0], v * 100]).filter((p) => p[0] >= start - DAY);
    if (!realised.length) throw new SourceError(DERIBIT, `not enough ${coin} price history for realised volatility`);
    const lastD = dvol[dvol.length - 1];
    const lastR = realised[realised.length - 1];
    const spreads: number[] = [];
    const rByDay = new Map(realised.map((p) => [Math.floor(p[0] / DAY), p[1]]));
    for (const [t, v] of dvol) {
      const r = rByDay.get(Math.floor(t / DAY));
      if (r !== undefined) spreads.push(v - r);
    }
    const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const dv = dvol.map((p) => p[1]);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: `${coin} DVOL`, value: lastD[1], format: 'pct', digits: 1 },
            { label: '30-day realised', value: lastR[1], format: 'pct', digits: 1 },
            { label: 'Implied - realised', value: lastD[1] - lastR[1], format: 'signed', digits: 1 },
            { label: 'Average gap over range', value: avg(spreads), format: 'signed', digits: 1 },
            { label: 'DVOL range low', value: Math.min(...dv), format: 'pct', digits: 1 },
            { label: 'DVOL range high', value: Math.max(...dv), format: 'pct', digits: 1 },
            { label: 'Implied daily move', value: lastD[1] / Math.sqrt(365), format: 'pct', digits: 2 },
          ],
        },
        {
          kind: 'chart',
          title: `${coin}: DVOL (30-day implied) vs 30-day realised volatility`,
          xType: 'time',
          yFormat: 'pct',
          yDigits: 0,
          series: [
            { name: 'DVOL', points: dvol },
            { name: '30d realised', points: realised },
          ],
        },
      ],
      sourceUrl: `https://www.deribit.com/statistics/${coin}/volatility-index`,
      asOf: new Date(lastD[0]).toISOString().slice(0, 10),
      notes: [
        'DVOL is Deribit\'s index of 30-day implied volatility (daily closes). Realised volatility is computed here: close-to-close on the perpetual\'s daily closes, 30-day window, annualised on 365 days.',
        'The latest point of each line is the day in progress.',
      ],
    };
  },
};

// ---------------------------------------------------------------- funding

export interface FundingRow {
  timestamp: number;
  interest_1h?: number;
  interest_8h?: number;
  index_price?: number;
}

/** Hourly funding to one row per UTC day: the sum of the hourly rates (percent), oldest first. */
export function dailyFunding(rows: FundingRow[]): { day: number; pct: number; hours: number; index: number | null }[] {
  const by = new Map<number, { day: number; pct: number; hours: number; index: number | null }>();
  for (const r of [...rows].sort((a, b) => a.timestamp - b.timestamp)) {
    if (typeof r.interest_1h !== 'number') continue;
    const day = Math.floor(r.timestamp / DAY) * DAY;
    const d = by.get(day) ?? { day, pct: 0, hours: 0, index: null };
    d.pct += r.interest_1h * 100;
    d.hours += 1;
    if (typeof r.index_price === 'number') d.index = r.index_price;
    by.set(day, d);
  }
  return [...by.values()].sort((a, b) => a.day - b.day);
}

interface Ticker {
  current_funding?: number;
  funding_8h?: number;
  mark_price?: number;
  index_price?: number;
  open_interest?: number;
  timestamp?: number;
}

const fundingCard: CardDef = {
  id: 'derivatives.crypto-funding',
  title: 'Perpetual Funding Rate',
  source: 'Deribit',
  description: 'Current and historical funding on the Deribit BTC or ETH perpetual: the 8-hour rate over 30 days and funding paid per day.',
  params: [CURRENCY_PARAM],
  async run(ctx, params) {
    const coin = coinOf(params);
    const name = `${coin}-PERPETUAL`;
    const end = ctx.now().getTime();
    const rows = await deribit<FundingRow[]>(ctx, 'get_funding_rate_history', { instrument_name: name, start_timestamp: end - 30 * DAY, end_timestamp: end }, 600);
    if (!Array.isArray(rows) || !rows.length) throw new SourceError(DERIBIT, `no funding history for ${name}`);
    rows.sort((a, b) => a.timestamp - b.timestamp);
    const tick = await deribit<Ticker>(ctx, 'ticker', { instrument_name: name }, 60);
    const daily = dailyFunding(rows);
    const total = daily.reduce((a, d) => a + d.pct, 0);
    const spanDays = (rows[rows.length - 1].timestamp - rows[0].timestamp) / DAY || 1;
    const last7 = daily.slice(-7).reduce((a, d) => a + d.pct, 0);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Current funding rate (8h equivalent)', value: tick.current_funding == null ? null : tick.current_funding * 100, format: 'pct', digits: 5 },
            { label: 'Funding, last 8 hours', value: tick.funding_8h == null ? null : tick.funding_8h * 100, format: 'pct', digits: 5 },
            { label: 'Current rate, annualised', value: tick.current_funding == null ? null : tick.current_funding * 3 * 365 * 100, format: 'pct', digits: 2 },
            { label: 'Paid by longs, last 7 days', value: last7, format: 'signedPct', digits: 4 },
            { label: `Paid by longs, last ${Math.round(spanDays)} days`, value: total, format: 'signedPct', digits: 4 },
            { label: 'That period, annualised', value: (total / spanDays) * 365, format: 'signedPct', digits: 2 },
            { label: 'Mark - index', value: tick.mark_price != null && tick.index_price != null ? tick.mark_price - tick.index_price : null, format: 'signed', digits: 2 },
            { label: 'Open interest (USD)', value: tick.open_interest, format: 'usdCompact' },
          ],
        },
        {
          kind: 'chart',
          title: `${name}: trailing 8-hour funding rate, hourly (%)`,
          xType: 'time',
          yFormat: 'pct',
          yDigits: 4,
          series: [{ name: '8h funding', points: rows.filter((r) => typeof r.interest_8h === 'number').map((r) => [r.timestamp, (r.interest_8h as number) * 100]) }],
        },
        {
          kind: 'table',
          title: 'Funding per day (UTC), newest first',
          columns: [
            { key: 'day', label: 'Day', format: 'date' },
            { key: 'pct', label: 'Funding paid by longs', format: 'signedPct', digits: 5 },
            { key: 'ann', label: 'Annualised', format: 'signedPct', digits: 2 },
            { key: 'index', label: 'Index at day end', format: 'usd', digits: 0 },
          ],
          rows: daily
            .slice(-14)
            .reverse()
            .map((d) => ({ day: d.day, pct: d.pct, ann: d.hours ? (d.pct / d.hours) * 24 * 365 : null, index: d.index })),
        },
      ],
      sourceUrl: `https://www.deribit.com/futures/${name}`,
      asOf: new Date(rows[rows.length - 1].timestamp).toISOString().slice(0, 16) + 'Z',
      notes: [
        'Positive funding is paid by longs to shorts; negative the reverse. Deribit accrues funding continuously; the daily figure is the sum of the hourly rates.',
        'The first and last day in the table may be partial.',
      ],
    };
  },
};

// ---------------------------------------------------------------- basis

const basisCard: CardDef = {
  id: 'derivatives.crypto-basis',
  title: 'Futures Basis',
  source: 'Deribit',
  description: 'Deribit dated BTC or ETH futures against the index: premium in dollars and percent, and annualised.',
  params: [CURRENCY_PARAM],
  async run(ctx, params) {
    const coin = coinOf(params);
    const list = await deribit<BookSummary[]>(ctx, 'get_book_summary_by_currency', { currency: coin, kind: 'future' }, 60);
    const now = ctx.now();
    const rows: Row[] = [];
    let index: number | null = null;
    for (const f of list) {
      const id = parseInstrument(f.instrument_name);
      const mark = f.mark_price;
      const idx = f.estimated_delivery_price;
      if (!id || id.currency !== coin || typeof mark !== 'number' || typeof idx !== 'number' || !(idx > 0)) continue;
      index = idx;
      const yearsLeft = id.expiry ? (Date.parse(`${id.expiry}T08:00:00Z`) - now.getTime()) / (365 * DAY) : null;
      const basisPct = (mark / idx - 1) * 100;
      rows.push({
        instrument: f.instrument_name,
        expiry: id.expiry ?? 'perpetual',
        days: yearsLeft === null ? null : Math.max(0, yearsLeft * 365),
        mark,
        basis: mark - idx,
        basisPct,
        ann: yearsLeft !== null && yearsLeft > 2 / 365 ? basisPct / yearsLeft : null,
        oi: f.open_interest,
        vol: f.volume_usd,
      });
    }
    if (!rows.length || index === null) throw new SourceError(DERIBIT, `no ${coin} futures listed`);
    rows.sort((a, b) => ((a.days as number | null) ?? -1) - ((b.days as number | null) ?? -1));
    const dated = rows.filter((r) => r.ann != null);
    return {
      blocks: [
        {
          kind: 'chart',
          title: `${coin}: annualised futures basis by days to expiry (%)`,
          xType: 'number',
          xLabel: 'Days to expiry',
          yFormat: 'pct',
          yDigits: 2,
          series: [{ name: 'Annualised basis', points: dated.map((r) => [r.days as number, r.ann as number]) }],
        },
        {
          kind: 'table',
          title: `${coin} index ${index.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
          columns: [
            { key: 'instrument', label: 'Instrument' },
            { key: 'expiry', label: 'Expiry' },
            { key: 'days', label: 'Days', format: 'num', digits: 0 },
            { key: 'mark', label: 'Mark', format: 'usd', digits: 2 },
            { key: 'basis', label: 'Basis', format: 'signed', digits: 2 },
            { key: 'basisPct', label: 'Basis %', format: 'signedPct', digits: 2 },
            { key: 'ann', label: 'Annualised', format: 'signedPct', digits: 2 },
            { key: 'oi', label: 'Open interest', format: 'usdCompact' },
            { key: 'vol', label: '24h volume', format: 'usdCompact' },
          ],
          rows,
        },
      ],
      sourceUrl: `https://www.deribit.com/futures/${coin}`,
      asOf: now.toISOString().slice(0, 16) + 'Z',
      notes: ['Basis = futures mark price minus the Deribit index. Annualised = basis % divided by years to expiry (simple, not compounded); contracts within two days of expiry are not annualised.'],
    };
  },
};

export const cryptoVolCards: CardDef[] = [smileCard, surfaceCard, dvolCard, fundingCard, basisCard];
