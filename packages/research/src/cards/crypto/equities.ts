/** Crypto in the stock market: spot bitcoin and ether ETFs, crypto companies, miners, and the public companies that hold coins. */
import { returnsBoard } from '../../lib/market.js';
import { SourceError, type CardDef, type Ctx } from '../../types.js';
import { GECKO, gecko } from './market-data.js';
import { list, minuteStamp, n, rec, share, str } from './util.js';

interface Item {
  symbol: string;
  label: string;
}

export const BTC_ETFS: Item[] = [
  { symbol: 'IBIT', label: 'iShares Bitcoin Trust' },
  { symbol: 'FBTC', label: 'Fidelity Wise Origin Bitcoin' },
  { symbol: 'GBTC', label: 'Grayscale Bitcoin Trust' },
  { symbol: 'BTC', label: 'Grayscale Bitcoin Mini Trust' },
  { symbol: 'ARKB', label: 'ARK 21Shares Bitcoin' },
  { symbol: 'BITB', label: 'Bitwise Bitcoin' },
  { symbol: 'HODL', label: 'VanEck Bitcoin' },
  { symbol: 'BRRR', label: 'CoinShares Bitcoin' },
  { symbol: 'EZBC', label: 'Franklin Bitcoin' },
  { symbol: 'BTCO', label: 'Invesco Galaxy Bitcoin' },
  { symbol: 'BTCW', label: 'WisdomTree Bitcoin' },
  { symbol: 'BITO', label: 'ProShares Bitcoin (futures)' },
];

export const ETH_ETFS: Item[] = [
  { symbol: 'ETHA', label: 'iShares Ethereum Trust' },
  { symbol: 'FETH', label: 'Fidelity Ethereum' },
  { symbol: 'ETHE', label: 'Grayscale Ethereum Trust' },
  { symbol: 'ETH', label: 'Grayscale Ethereum Mini Trust' },
  { symbol: 'ETHW', label: 'Bitwise Ethereum' },
  { symbol: 'ETHV', label: 'VanEck Ethereum' },
  { symbol: 'EZET', label: 'Franklin Ethereum' },
  { symbol: 'QETH', label: 'Invesco Galaxy Ethereum' },
];

export const CRYPTO_STOCKS: Item[] = [
  { symbol: 'COIN', label: 'Coinbase' },
  { symbol: 'HOOD', label: 'Robinhood' },
  { symbol: 'MSTR', label: 'Strategy' },
  { symbol: 'CRCL', label: 'Circle' },
  { symbol: 'GLXY', label: 'Galaxy Digital' },
  { symbol: 'BLSH', label: 'Bullish' },
  { symbol: 'BMNR', label: 'BitMine Immersion' },
  { symbol: 'SBET', label: 'SharpLink Gaming' },
  { symbol: 'XYZ', label: 'Block' },
  { symbol: 'PYPL', label: 'PayPal' },
  { symbol: 'CME', label: 'CME Group' },
];

export const MINERS: Item[] = [
  { symbol: 'MARA', label: 'MARA Holdings' },
  { symbol: 'RIOT', label: 'Riot Platforms' },
  { symbol: 'CLSK', label: 'CleanSpark' },
  { symbol: 'CORZ', label: 'Core Scientific' },
  { symbol: 'IREN', label: 'IREN' },
  { symbol: 'WULF', label: 'TeraWulf' },
  { symbol: 'CIFR', label: 'Cipher Mining' },
  { symbol: 'HUT', label: 'Hut 8' },
  { symbol: 'BTDR', label: 'Bitdeer' },
  { symbol: 'HIVE', label: 'HIVE Digital' },
];

function board(id: string, title: string, description: string, items: Item[], benchmark: Item, note: string): CardDef {
  return {
    id,
    title,
    source: 'Nasdaq',
    description,
    async run(ctx: Ctx) {
      const b = await returnsBoard(ctx, [...items, benchmark]);
      return { blocks: [b.block], source: b.source, notes: [note, ...b.notes] };
    },
  };
}

const btcEtfs = board(
  'crypto.btc-etfs',
  'Bitcoin ETFs',
  'U.S. bitcoin exchange-traded funds: last close and returns over a day, a week, a month, three months, the year to date and a year, against bitcoin itself.',
  BTC_ETFS,
  { symbol: 'BTC-USD', label: 'Bitcoin (spot)' },
  'Share prices, not fund flows or assets. Spot funds hold bitcoin and track it less their fee; BITO holds futures. The bitcoin row trades every day, so its returns are measured to a different last close on weekends.',
);

const ethEtfs = board(
  'crypto.eth-etfs',
  'Ether ETFs',
  'U.S. ether exchange-traded funds: last close and returns over standard horizons, against ether itself.',
  ETH_ETFS,
  { symbol: 'ETH-USD', label: 'Ether (spot)' },
  'Share prices, not fund flows or assets. The ether row trades every day, so its returns are measured to a different last close on weekends.',
);

const stocks = board(
  'crypto.stocks',
  'Crypto Stocks',
  'Listed companies whose business is crypto: exchanges, brokers, stablecoin issuers and treasury companies, with returns over standard horizons.',
  CRYPTO_STOCKS,
  { symbol: 'BTC-USD', label: 'Bitcoin (spot)' },
  'A hand-picked list of U.S.-listed companies with large crypto businesses or holdings; it is not an index.',
);

const miners = board(
  'crypto.miners',
  'Bitcoin Miners',
  'U.S.-listed bitcoin mining companies, with returns over standard horizons against bitcoin.',
  MINERS,
  { symbol: 'BTC-USD', label: 'Bitcoin (spot)' },
  'Several miners now earn a large share of revenue from hosting AI computing, so they no longer move with bitcoin alone.',
);

// ---------------------------------------------------------------- treasuries

export interface Treasury {
  name: string;
  symbol: string;
  country: string;
  holdings: number;
  cost: number | null;
  value: number | null;
  supplyPct: number | null;
}

/** CoinGecko `GET /companies/public_treasury/{coin}`. */
export function parseTreasuries(body: unknown): { total: number | null; value: number | null; dominance: number | null; companies: Treasury[] } {
  const b = rec(body);
  const companies: Treasury[] = [];
  for (const raw of list(b.companies)) {
    const c = rec(raw);
    const holdings = n(c.total_holdings);
    if (!str(c.name) || holdings === null || !(holdings > 0)) continue;
    const cost = n(c.total_entry_value_usd);
    companies.push({ name: str(c.name), symbol: str(c.symbol), country: str(c.country), holdings, cost: cost && cost > 0 ? cost : null, value: n(c.total_current_value_usd), supplyPct: n(c.percentage_of_total_supply) });
  }
  companies.sort((a, c) => c.holdings - a.holdings);
  return { total: n(b.total_holdings), value: n(b.total_value_usd), dominance: n(b.market_cap_dominance), companies };
}

const COINS: Record<string, { id: string; unit: string }> = { bitcoin: { id: 'bitcoin', unit: 'BTC' }, ether: { id: 'ethereum', unit: 'ETH' } };

const treasuries: CardDef = {
  id: 'crypto.treasuries',
  title: 'Public Company Treasuries',
  source: GECKO,
  description: 'Listed companies that hold bitcoin or ether on their balance sheets: coins held, what they paid, current value and share of supply.',
  params: [{ name: 'coin', label: 'Coin', default: 'bitcoin', choices: Object.keys(COINS) }],
  async run(ctx, params) {
    const coin = COINS[params.coin] ? params.coin : 'bitcoin';
    const { id, unit } = COINS[coin];
    const t = parseTreasuries(await gecko<unknown>(ctx, `/companies/public_treasury/${id}`, 21_600));
    if (!t.companies.length) throw new SourceError(GECKO, `no companies returned for ${coin}`);
    const top = t.companies[0];
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: `Held by companies (${unit})`, value: t.total, format: 'num', digits: 0 },
            { label: 'Value', value: t.value, format: 'usdCompact' },
            { label: 'Share of supply', value: t.dominance, format: 'pct', digits: 2 },
            { label: 'Companies', value: t.companies.length, format: 'int' },
            { label: 'Largest holder', value: top.name },
            { label: 'Its share of the total', value: share(top.holdings, t.total), format: 'pct' },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Company', maxWidth: 30 },
            { key: 'symbol', label: 'Ticker' },
            { key: 'country', label: 'Country' },
            { key: 'holdings', label: `Held (${unit})`, format: 'num', digits: 0 },
            { key: 'value', label: 'Value', format: 'usdCompact' },
            { key: 'cost', label: 'Cost', format: 'usdCompact' },
            { key: 'gain', label: 'Gain on cost', format: 'signedPct' },
            { key: 'supplyPct', label: 'Of supply', format: 'pct', digits: 3 },
          ],
          rows: t.companies.slice(0, 40).map((c, i) => ({ rank: i + 1, ...c, gain: c.cost && c.value ? (c.value / c.cost - 1) * 100 : null })),
        },
      ],
      sourceUrl: `https://www.coingecko.com/en/treasuries/${id}`,
      asOf: minuteStamp(ctx),
      notes: ['Holdings are taken from company filings and announcements as CoinGecko collects them, so a recent purchase or sale may not show yet. Cost is blank where a company has not disclosed it. Refreshed here every six hours.'],
    };
  },
};

export const equityCards: CardDef[] = [btcEtfs, ethEtfs, stocks, miners, treasuries];
