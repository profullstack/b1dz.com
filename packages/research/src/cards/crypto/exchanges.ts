/** Exchanges: spot venues by volume, derivatives venues by open interest, and the assets centralized exchanges hold. */
import { SourceError, type CardDef } from '../../types.js';
import { LLAMA, llama } from './defi.js';
import { GECKO, PAPRIKA, gecko, loadMarket, paprika } from './market-data.js';
import { list, minuteStamp, n, rec, share, str, sum } from './util.js';

export interface SpotExchange {
  name: string;
  rank: number;
  volume24h: number;
  volume7d: number | null;
  volume30d: number | null;
  markets: number | null;
  currencies: number | null;
  confidence: number | null;
}

/** CoinPaprika `GET /exchanges`: active exchanges by the provider's adjusted 24-hour volume. */
export function parseSpotExchanges(body: unknown): SpotExchange[] {
  const out: SpotExchange[] = [];
  for (const raw of list(body)) {
    const e = rec(raw);
    const q = rec(rec(e.quotes).USD);
    const vol = n(q.adjusted_volume_24h);
    const rank = n(e.adjusted_rank);
    if (!str(e.name) || e.active !== true || vol === null || !(vol > 0) || rank === null) continue;
    out.push({ name: str(e.name), rank, volume24h: vol, volume7d: n(q.adjusted_volume_7d), volume30d: n(q.adjusted_volume_30d), markets: n(e.markets), currencies: n(e.currencies), confidence: n(e.confidence_score) });
  }
  return out.sort((a, b) => b.volume24h - a.volume24h);
}

const spot: CardDef = {
  id: 'crypto.exchanges-spot',
  title: 'Spot Exchanges by Volume',
  source: PAPRIKA,
  description: 'Crypto exchanges ranked by 24-hour trading volume, with 7-day and 30-day volume, market share and how many markets each lists.',
  async run(ctx) {
    const all = parseSpotExchanges(await paprika<unknown>(ctx, '/exchanges', 3600));
    if (!all.length) throw new SourceError(PAPRIKA, 'no exchanges returned');
    const total = sum(all.map((e) => e.volume24h));
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: '24h volume', value: total, format: 'usdCompact' },
            { label: 'Exchanges with volume', value: all.length, format: 'int' },
            { label: `${all[0].name} share`, value: share(all[0].volume24h, total), format: 'pct' },
            { label: 'Top 5 exchanges', value: share(sum(all.slice(0, 5).map((e) => e.volume24h)), total), format: 'pct' },
            { label: 'Top 10 exchanges', value: share(sum(all.slice(0, 10).map((e) => e.volume24h)), total), format: 'pct' },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Exchange', maxWidth: 26 },
            { key: 'volume24h', label: '24h volume', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'volume7d', label: '7d', format: 'usdCompact' },
            { key: 'volume30d', label: '30d', format: 'usdCompact' },
            { key: 'markets', label: 'Markets', format: 'int' },
            { key: 'currencies', label: 'Coins', format: 'int' },
            { key: 'confidence', label: 'Confidence', format: 'pct', digits: 0 },
          ],
          rows: all.slice(0, 40).map((e, i) => ({ ...e, rank: i + 1, share: share(e.volume24h, total), confidence: e.confidence === null ? null : e.confidence * 100 })),
        },
      ],
      sourceUrl: 'https://coinpaprika.com/exchanges/',
      asOf: minuteStamp(ctx),
      notes: ['Volume is what each exchange reports, after the provider removes markets it judges to be inflated. It includes both centralized and decentralized venues. Confidence is the provider\'s score for how believable an exchange\'s volume is.'],
    };
  },
};

export interface DerivExchange {
  name: string;
  /** In bitcoin, as CoinGecko reports it. */
  openInterestBtc: number | null;
  volumeBtc: number | null;
  perpetuals: number | null;
  futures: number | null;
  country: string;
  year: number | null;
}

/** CoinGecko `GET /derivatives/exchanges`. */
export function parseDerivExchanges(body: unknown): DerivExchange[] {
  const out: DerivExchange[] = [];
  for (const raw of list(body)) {
    const e = rec(raw);
    if (!str(e.name)) continue;
    out.push({ name: str(e.name), openInterestBtc: n(e.open_interest_btc), volumeBtc: n(e.trade_volume_24h_btc), perpetuals: n(e.number_of_perpetual_pairs), futures: n(e.number_of_futures_pairs), country: str(e.country), year: n(e.year_established) });
  }
  return out.sort((a, b) => (b.openInterestBtc ?? 0) - (a.openInterestBtc ?? 0));
}

const derivatives: CardDef = {
  id: 'crypto.exchanges-derivatives',
  title: 'Derivatives Exchanges',
  source: GECKO,
  description: 'Crypto derivatives venues ranked by open interest, with 24-hour volume and the number of perpetual and dated contracts.',
  async run(ctx) {
    const [all, market] = await Promise.all([gecko<unknown>(ctx, '/derivatives/exchanges?per_page=60&order=open_interest_btc_desc', 3600).then(parseDerivExchanges), loadMarket(ctx).catch(() => null)]);
    if (!all.length) throw new SourceError(GECKO, 'no derivatives exchanges returned');
    const btc = market?.coins.find((c) => c.symbol === 'BTC')?.price ?? null;
    const usd = (v: number | null) => (v === null || btc === null ? null : v * btc);
    const totalOi = sum(all.map((e) => e.openInterestBtc));
    const totalVol = sum(all.map((e) => e.volumeBtc));
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Open interest', value: usd(totalOi), format: 'usdCompact' },
            { label: '24h volume', value: usd(totalVol), format: 'usdCompact' },
            { label: 'Largest venue share', value: share(all[0].openInterestBtc, totalOi), format: 'pct' },
            { label: 'Top 3 venues', value: share(sum(all.slice(0, 3).map((e) => e.openInterestBtc)), totalOi), format: 'pct' },
            { label: 'Volume / open interest', value: totalOi ? totalVol / totalOi : null, format: 'num', digits: 2 },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Venue', maxWidth: 28 },
            { key: 'oi', label: 'Open interest', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'volume', label: '24h volume', format: 'usdCompact' },
            { key: 'perpetuals', label: 'Perpetuals', format: 'int' },
            { key: 'futures', label: 'Dated', format: 'int' },
            { key: 'country', label: 'Based in', maxWidth: 22 },
          ],
          rows: all.slice(0, 40).map((e, i) => ({ rank: i + 1, name: e.name, oi: usd(e.openInterestBtc), share: share(e.openInterestBtc, totalOi), volume: usd(e.volumeBtc), perpetuals: e.perpetuals, futures: e.futures, country: e.country })),
        },
      ],
      source: market ? `${GECKO}, ${market.source}` : GECKO,
      sourceUrl: 'https://www.coingecko.com/en/exchanges/derivatives',
      asOf: minuteStamp(ctx),
      notes: [
        'CoinGecko reports open interest and volume in bitcoin; they are converted to dollars here at the current bitcoin price. Includes centralized and on-chain venues. Refreshed here once an hour.',
        ...(btc === null ? ['No bitcoin price was available, so dollar values are blank.'] : []),
      ],
    };
  },
};

export interface Reserve {
  name: string;
  assets: number;
  /** Assets excluding the exchange's own token. */
  clean: number | null;
  inflow24h: number | null;
  inflow7d: number | null;
  inflow30d: number | null;
  spotVolume: number | null;
  openInterest: number | null;
}

/** DefiLlama `GET /cexs`: assets in the wallets each exchange has disclosed, largest first. */
export function parseReserves(body: unknown): Reserve[] {
  const out: Reserve[] = [];
  for (const raw of list(rec(body).cexs)) {
    const c = rec(raw);
    const assets = n(c.currentTvl);
    if (!str(c.name) || assets === null || !(assets > 0)) continue;
    out.push({ name: str(c.name), assets, clean: n(c.cleanAssetsTvl), inflow24h: n(c.inflows_24h), inflow7d: n(c.inflows_1w), inflow30d: n(c.inflows_1m), spotVolume: n(c.spotVolume), openInterest: n(c.oi) });
  }
  return out.sort((a, b) => b.assets - a.assets);
}

const reserves: CardDef = {
  id: 'crypto.exchange-reserves',
  title: 'Exchange Reserves and Flows',
  source: LLAMA,
  description: 'Assets held in the disclosed wallets of centralized exchanges, with net inflows over a day, a week and a month.',
  async run(ctx) {
    const all = parseReserves(await llama(ctx, 'https://api.llama.fi/cexs', 1800));
    if (!all.length) throw new SourceError(LLAMA, 'no exchanges returned');
    const total = sum(all.map((r) => r.assets));
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Assets tracked', value: total, format: 'usdCompact' },
            { label: 'Net flow, 24 hours', value: sum(all.map((r) => r.inflow24h)), format: 'usdCompact' },
            { label: 'Net flow, 7 days', value: sum(all.map((r) => r.inflow7d)), format: 'usdCompact' },
            { label: 'Net flow, 30 days', value: sum(all.map((r) => r.inflow30d)), format: 'usdCompact' },
            { label: `${all[0].name} share`, value: share(all[0].assets, total), format: 'pct' },
            { label: 'Exchanges tracked', value: all.length, format: 'int' },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Exchange', maxWidth: 22 },
            { key: 'assets', label: 'Assets', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'own', label: 'Own token', format: 'pct' },
            { key: 'inflow24h', label: 'Flow, 24h', format: 'usdCompact' },
            { key: 'inflow7d', label: 'Flow, 7d', format: 'usdCompact' },
            { key: 'inflow30d', label: 'Flow, 30d', format: 'usdCompact' },
            { key: 'spotVolume', label: 'Spot volume', format: 'usdCompact' },
            { key: 'openInterest', label: 'Open interest', format: 'usdCompact' },
          ],
          rows: all.slice(0, 35).map((r, i) => ({ rank: i + 1, ...r, share: share(r.assets, total), own: r.clean !== null ? share(r.assets - r.clean, r.assets) : null })),
        },
      ],
      sourceUrl: 'https://defillama.com/cexs',
      asOf: minuteStamp(ctx),
      notes: [
        'Assets are what sits in the wallets each exchange has published; an exchange can hold more in wallets it has not disclosed, and this says nothing about what it owes customers. Flows are in dollars and positive when assets arrived.',
        'Exchanges that have not published their wallets (Coinbase, Upbit and Bithumb among them) are not ranked.',
      ],
    };
  },
};

export const exchangeCards: CardDef[] = [spot, derivatives, reserves];
