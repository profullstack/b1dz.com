/**
 * Crypto area: markets, one coin, derivatives, DeFi, stablecoins, Bitcoin and
 * Ethereum on chain, ETFs and stocks, exchanges and news. The Deribit option,
 * volatility and funding cards live in ../derivatives and are placed on the
 * dashboards here.
 */
import type { AreaModule, DashboardDef, SearchHit } from '../../types.js';
import { bitcoinCards } from './bitcoin.js';
import { coinCards } from './coin.js';
import { defiCards } from './defi.js';
import { equityCards } from './equities.js';
import { ethereumCards } from './ethereum.js';
import { exchangeCards } from './exchanges.js';
import { marketCards } from './markets.js';
import { cryptoNewsCards } from './news.js';
import { perpCards } from './perps.js';
import { stablecoinCards } from './stablecoins.js';

const GROUP = 'Crypto';

export const cryptoDashboards: DashboardDef[] = [
  {
    id: 'crypto-markets',
    title: 'Crypto Markets',
    group: GROUP,
    tabs: [
      { id: 'overview', title: 'Overview', cards: ['crypto.global', 'crypto.top-coins', 'derivatives.crypto-spot'] },
      { id: 'movers', title: 'Movers', cards: ['crypto.movers', 'crypto.performance', 'crypto.ath'] },
      { id: 'sentiment', title: 'Sentiment', cards: ['crypto.fear-greed', 'crypto.trending'] },
      { id: 'sectors', title: 'Sectors', cards: ['crypto.categories'] },
    ],
  },
  {
    id: 'crypto',
    title: 'Crypto: Coin',
    group: GROUP,
    tabs: [
      { id: 'spot', title: 'Overview', cards: ['crypto.coin-profile', 'derivatives.crypto-history', 'crypto.coin-cap-history'] },
      { id: 'technicals', title: 'Technicals', cards: ['crypto.technical-summary', 'crypto.trendlines', 'crypto.patterns'] },
      { id: 'venues', title: 'Venues', cards: ['crypto.price-compare', 'crypto.coin-venues'] },
      { id: 'book', title: 'Order book', cards: ['crypto.spot-book', 'derivatives.crypto-order-book'] },
      { id: 'options', title: 'Options', cards: ['derivatives.crypto-options', 'derivatives.crypto-options-expiries'] },
      { id: 'volatility', title: 'Volatility', cards: ['derivatives.crypto-smile', 'derivatives.crypto-surface', 'derivatives.crypto-dvol'] },
      { id: 'funding', title: 'Funding', cards: ['crypto.funding-history', 'derivatives.crypto-funding', 'derivatives.crypto-basis'] },
      { id: 'news', title: 'News', cards: ['crypto.news-search'] },
    ],
  },
  {
    id: 'crypto-derivatives',
    title: 'Crypto Derivatives',
    group: GROUP,
    tabs: [
      { id: 'funding', title: 'Funding', cards: ['crypto.funding-venues', 'crypto.funding-history'] },
      { id: 'open-interest', title: 'Open interest', cards: ['crypto.open-interest', 'crypto.onchain-open-interest'] },
      { id: 'venues', title: 'Venues', cards: ['crypto.hyperliquid-perps', 'crypto.okx-perps'] },
      { id: 'basis', title: 'Basis', cards: ['crypto.kraken-futures', 'derivatives.crypto-basis'] },
      { id: 'positioning', title: 'Positioning', cards: ['crypto.positioning', 'crypto.liquidations'] },
      { id: 'options', title: 'Options', cards: ['derivatives.crypto-options-expiries', 'derivatives.crypto-dvol'] },
    ],
  },
  {
    id: 'defi',
    title: 'DeFi',
    group: GROUP,
    tabs: [
      { id: 'tvl', title: 'Value locked', cards: ['crypto.defi-tvl', 'crypto.defi-chains'] },
      { id: 'protocols', title: 'Protocols', cards: ['crypto.defi-protocols', 'crypto.defi-categories'] },
      { id: 'dexs', title: 'DEX volume', cards: ['crypto.dex-volume', 'crypto.dex-chains'] },
      { id: 'fees', title: 'Fees & revenue', cards: ['crypto.defi-fees'] },
      { id: 'yields', title: 'Yields', cards: ['crypto.defi-yields'] },
      { id: 'hacks', title: 'Hacks', cards: ['crypto.defi-hacks'] },
    ],
  },
  {
    id: 'stablecoins',
    title: 'Stablecoins',
    group: GROUP,
    tabs: [
      { id: 'supply', title: 'Supply', cards: ['crypto.stablecoin-supply', 'crypto.stablecoin-history'] },
      { id: 'pegs', title: 'Pegs', cards: ['crypto.stablecoin-pegs'] },
      { id: 'chains', title: 'By chain', cards: ['crypto.stablecoin-chains'] },
    ],
  },
  {
    id: 'bitcoin',
    title: 'Bitcoin On-Chain',
    group: GROUP,
    tabs: [
      { id: 'fees', title: 'Mempool & fees', cards: ['crypto.btc-mempool', 'crypto.btc-blocks'] },
      { id: 'mining', title: 'Mining', cards: ['crypto.btc-hashrate', 'crypto.btc-difficulty', 'crypto.btc-pools', 'crypto.btc-miner-revenue'] },
      { id: 'supply', title: 'Halving & supply', cards: ['crypto.btc-halving'] },
      { id: 'activity', title: 'Activity', cards: ['crypto.btc-activity'] },
      { id: 'lightning', title: 'Lightning', cards: ['crypto.btc-lightning'] },
    ],
  },
  {
    id: 'ethereum',
    title: 'Ethereum On-Chain',
    group: GROUP,
    tabs: [
      { id: 'supply', title: 'Supply & burn', cards: ['crypto.eth-supply', 'crypto.eth-supply-history'] },
      { id: 'gas', title: 'Gas & activity', cards: ['crypto.eth-gas', 'crypto.eth-activity'] },
      { id: 'staking', title: 'Staking', cards: ['crypto.eth-staking'] },
      { id: 'l2', title: 'Layer 2', cards: ['crypto.l2-projects', 'crypto.l2-tvs', 'crypto.l2-activity'] },
    ],
  },
  {
    id: 'crypto-equities',
    title: 'Crypto ETFs & Stocks',
    group: GROUP,
    tabs: [
      { id: 'etfs', title: 'ETFs', cards: ['crypto.btc-etfs', 'crypto.eth-etfs'] },
      { id: 'stocks', title: 'Stocks', cards: ['crypto.stocks', 'crypto.miners'] },
      { id: 'treasuries', title: 'Treasuries', cards: ['crypto.treasuries'] },
    ],
  },
  {
    id: 'crypto-exchanges',
    title: 'Crypto Exchanges',
    group: GROUP,
    tabs: [
      { id: 'spot', title: 'Spot', cards: ['crypto.exchanges-spot'] },
      { id: 'derivatives', title: 'Derivatives', cards: ['crypto.exchanges-derivatives'] },
      { id: 'reserves', title: 'Reserves & flows', cards: ['crypto.exchange-reserves'] },
      { id: 'dex', title: 'Decentralized', cards: ['crypto.dex-volume'] },
    ],
  },
  {
    id: 'crypto-news',
    title: 'Crypto News',
    group: GROUP,
    tabs: [
      { id: 'headlines', title: 'Headlines', cards: ['crypto.news'] },
      { id: 'coin', title: 'Coin or topic', cards: ['crypto.news-search'] },
      { id: 'research', title: 'Research', cards: ['crypto.news-research'] },
    ],
  },
];

/** Coins a search can name. Symbol first; the name is what people type. */
export const SEARCH_COINS: [string, string][] = [
  ['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['SOL', 'Solana'], ['XRP', 'XRP'], ['BNB', 'BNB'], ['DOGE', 'Dogecoin'], ['ADA', 'Cardano'], ['TRX', 'TRON'],
  ['AVAX', 'Avalanche'], ['LINK', 'Chainlink'], ['LTC', 'Litecoin'], ['BCH', 'Bitcoin Cash'], ['DOT', 'Polkadot'], ['UNI', 'Uniswap'], ['AAVE', 'Aave'],
  ['XLM', 'Stellar'], ['SUI', 'Sui'], ['HBAR', 'Hedera'], ['HYPE', 'Hyperliquid'], ['TON', 'Toncoin'], ['SHIB', 'Shiba Inu'], ['NEAR', 'NEAR Protocol'],
  ['APT', 'Aptos'], ['ARB', 'Arbitrum'], ['OP', 'Optimism'], ['POL', 'Polygon'], ['ATOM', 'Cosmos'], ['ETC', 'Ethereum Classic'], ['XMR', 'Monero'],
  ['ZEC', 'Zcash'], ['FIL', 'Filecoin'], ['ICP', 'Internet Computer'], ['ALGO', 'Algorand'], ['INJ', 'Injective'], ['SEI', 'Sei'], ['TIA', 'Celestia'],
  ['ENA', 'Ethena'], ['ONDO', 'Ondo'], ['PEPE', 'Pepe'], ['BONK', 'Bonk'], ['WIF', 'dogwifhat'], ['MKR', 'Maker'], ['CRV', 'Curve'], ['LDO', 'Lido'],
  ['JUP', 'Jupiter'], ['RENDER', 'Render'], ['TAO', 'Bittensor'], ['FET', 'Fetch.ai'], ['WLD', 'Worldcoin'], ['PENGU', 'Pudgy Penguins'],
  ['USDT', 'Tether'], ['USDC', 'USD Coin'], ['DAI', 'Dai'],
];

const STABLES = new Set(['USDT', 'USDC', 'DAI']);

/** Words that jump straight to a tab. */
const TOPICS: { words: string[]; hit: SearchHit }[] = [
  { words: ['market cap', 'top coins', 'altcoin', 'crypto market', 'dominance'], hit: { kind: 'dataset', label: 'Top coins, total market cap and dominance', detail: 'Crypto Markets > Overview', dashboard: 'crypto-markets', tab: 'overview' } },
  { words: ['gainers', 'losers', 'movers'], hit: { kind: 'dataset', label: 'Crypto gainers and losers', detail: 'Crypto Markets > Movers', dashboard: 'crypto-markets', tab: 'movers' } },
  { words: ['fear', 'greed', 'sentiment', 'trending'], hit: { kind: 'dataset', label: 'Fear and Greed Index, trending coins', detail: 'Crypto Markets > Sentiment', dashboard: 'crypto-markets', tab: 'sentiment' } },
  { words: ['funding rate', 'perpetual', 'perps'], hit: { kind: 'dataset', label: 'Perpetual funding rates across venues', detail: 'Crypto Derivatives > Funding', dashboard: 'crypto-derivatives', tab: 'funding' } },
  { words: ['open interest', 'liquidation', 'long short', 'long/short'], hit: { kind: 'dataset', label: 'Crypto open interest, positioning and liquidations', detail: 'Crypto Derivatives > Open interest', dashboard: 'crypto-derivatives', tab: 'open-interest' } },
  { words: ['defi', 'tvl', 'value locked'], hit: { kind: 'dataset', label: 'DeFi value locked by chain and protocol', detail: 'DeFi > Value locked', dashboard: 'defi', tab: 'tvl' } },
  { words: ['dex', 'uniswap volume', 'decentralized exchange'], hit: { kind: 'dataset', label: 'DEX volume', detail: 'DeFi > DEX volume', dashboard: 'defi', tab: 'dexs' } },
  { words: ['yield', 'apy', 'staking yield'], hit: { kind: 'dataset', label: 'DeFi yields', detail: 'DeFi > Yields', dashboard: 'defi', tab: 'yields' } },
  { words: ['hack', 'exploit'], hit: { kind: 'dataset', label: 'Crypto hacks and exploits', detail: 'DeFi > Hacks', dashboard: 'defi', tab: 'hacks' } },
  { words: ['stablecoin', 'depeg', 'peg'], hit: { kind: 'dataset', label: 'Stablecoin supply and pegs', detail: 'Stablecoins > Supply', dashboard: 'stablecoins', tab: 'supply' } },
  { words: ['mempool', 'sat/vb', 'bitcoin fee'], hit: { kind: 'dataset', label: 'Bitcoin mempool and fees', detail: 'Bitcoin On-Chain > Mempool & fees', dashboard: 'bitcoin', tab: 'fees' } },
  { words: ['hashrate', 'difficulty', 'mining pool', 'miner'], hit: { kind: 'dataset', label: 'Bitcoin hashrate, difficulty and mining pools', detail: 'Bitcoin On-Chain > Mining', dashboard: 'bitcoin', tab: 'mining' } },
  { words: ['halving'], hit: { kind: 'dataset', label: 'Bitcoin halving countdown and supply', detail: 'Bitcoin On-Chain > Halving & supply', dashboard: 'bitcoin', tab: 'supply' } },
  { words: ['lightning'], hit: { kind: 'dataset', label: 'Lightning Network capacity and nodes', detail: 'Bitcoin On-Chain > Lightning', dashboard: 'bitcoin', tab: 'lightning' } },
  { words: ['gas', 'gwei'], hit: { kind: 'dataset', label: 'Ethereum gas prices', detail: 'Ethereum On-Chain > Gas & activity', dashboard: 'ethereum', tab: 'gas' } },
  { words: ['burn', 'ultrasound', 'eth supply', 'ether supply', 'eth staking'], hit: { kind: 'dataset', label: 'Ether supply, burn and staking', detail: 'Ethereum On-Chain > Supply & burn', dashboard: 'ethereum', tab: 'supply' } },
  { words: ['layer 2', 'l2', 'rollup'], hit: { kind: 'dataset', label: 'Ethereum layer 2 networks', detail: 'Ethereum On-Chain > Layer 2', dashboard: 'ethereum', tab: 'l2' } },
  { words: ['bitcoin etf', 'crypto etf', 'ibit', 'spot etf', 'ether etf'], hit: { kind: 'dataset', label: 'Bitcoin and ether ETFs', detail: 'Crypto ETFs & Stocks > ETFs', dashboard: 'crypto-equities', tab: 'etfs' } },
  { words: ['treasury', 'treasuries', 'microstrategy'], hit: { kind: 'dataset', label: 'Public companies holding bitcoin or ether', detail: 'Crypto ETFs & Stocks > Treasuries', dashboard: 'crypto-equities', tab: 'treasuries' } },
  { words: ['crypto exchange', 'exchange volume', 'proof of reserves', 'exchange reserves'], hit: { kind: 'dataset', label: 'Crypto exchanges by volume and reserves', detail: 'Crypto Exchanges > Spot', dashboard: 'crypto-exchanges', tab: 'spot' } },
  { words: ['crypto news'], hit: { kind: 'dataset', label: 'Crypto headlines', detail: 'Crypto News > Headlines', dashboard: 'crypto-news', tab: 'headlines' } },
];

/** A typed coin (symbol, pair or name) to its symbol, or null. */
export function searchCoin(query: string): { symbol: string; name: string } | null {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return null;
  const bare = q.replace(/[-/\s]?(usd|usdt|usdc)$/, '');
  for (const [symbol, name] of SEARCH_COINS) {
    const s = symbol.toLowerCase();
    if (s === q || (bare.length >= 2 && s === bare && bare !== q) || name.toLowerCase() === q) return { symbol, name };
  }
  if (q.length >= 4) {
    const hit = SEARCH_COINS.find(([, name]) => name.toLowerCase().startsWith(q));
    if (hit) return { symbol: hit[0], name: hit[1] };
  }
  return null;
}

/** Jump targets for a typed query: a coin opens its dashboards, a topic opens its tab. */
export function cryptoSearch(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  const coin = searchCoin(q);
  if (coin) {
    const { symbol, name } = coin;
    const params = { symbol: `${symbol}-USD` };
    const who = name === symbol ? symbol : `${name} (${symbol})`;
    hits.push({ kind: 'security', label: `${who}: profile, price and supply`, detail: 'Crypto: Coin > Overview', dashboard: 'crypto', tab: 'spot', params });
    if (STABLES.has(symbol)) {
      hits.push({ kind: 'dataset', label: `${symbol}: stablecoin supply and peg`, detail: 'Stablecoins > Supply', dashboard: 'stablecoins', tab: 'supply' });
    } else {
      hits.push({ kind: 'security', label: `${symbol} price across exchanges`, detail: 'Crypto: Coin > Venues', dashboard: 'crypto', tab: 'venues', params });
      hits.push({ kind: 'security', label: `${symbol} funding rates`, detail: 'Crypto Derivatives > Funding', dashboard: 'crypto-derivatives', tab: 'funding', params });
      hits.push({ kind: 'security', label: `${symbol} open interest by venue`, detail: 'Crypto Derivatives > Open interest', dashboard: 'crypto-derivatives', tab: 'open-interest', params });
    }
    hits.push({ kind: 'security', label: `${symbol} news`, detail: 'Crypto News > Coin or topic', dashboard: 'crypto-news', tab: 'coin', params });
    if (symbol === 'BTC') {
      hits.push({ kind: 'dashboard', label: 'Bitcoin on chain: fees, mining, halving, Lightning', detail: 'Crypto', dashboard: 'bitcoin' });
      hits.push({ kind: 'dataset', label: 'Bitcoin ETFs', detail: 'Crypto ETFs & Stocks > ETFs', dashboard: 'crypto-equities', tab: 'etfs' });
    }
    if (symbol === 'ETH') {
      hits.push({ kind: 'dashboard', label: 'Ethereum on chain: supply, gas, staking, layer 2', detail: 'Crypto', dashboard: 'ethereum' });
      hits.push({ kind: 'dataset', label: 'Ether ETFs', detail: 'Crypto ETFs & Stocks > ETFs', dashboard: 'crypto-equities', tab: 'etfs' });
    }
  }
  if (q.length >= 3) for (const t of TOPICS) if (t.words.some((w) => w === q || w.startsWith(q) || (q.length >= 4 && q.includes(w)))) hits.push(t.hit);
  if (q === 'crypto') hits.push({ kind: 'dashboard', label: 'Crypto Markets', detail: 'Crypto', dashboard: 'crypto-markets' });
  return hits.slice(0, 10);
}

export const crypto: AreaModule = {
  cards: [...marketCards, ...coinCards, ...perpCards, ...defiCards, ...stablecoinCards, ...bitcoinCards, ...ethereumCards, ...equityCards, ...exchangeCards, ...cryptoNewsCards],
  dashboards: cryptoDashboards,
  search: async (_ctx, query) => cryptoSearch(query),
};
