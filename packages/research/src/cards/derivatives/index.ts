/** Derivatives area: equity options, futures and positioning, crypto. */
import type { AreaModule, DashboardDef, SearchHit } from '../../types.js';
import { cryptoCurrency } from './chain.js';
import { cryptoCards } from './crypto.js';
import { cryptoVolCards } from './crypto-vol.js';
import { COT_MARKETS, futuresCards } from './futures.js';
import { optionCards } from './options.js';
import { optionVolCards } from './options-vol.js';

const dashboards: DashboardDef[] = [
  {
    id: 'options',
    title: 'Equity Options',
    group: 'Derivatives',
    tabs: [
      { id: 'chain', title: 'Chain', cards: ['derivatives.options-chain'] },
      { id: 'stats', title: 'Stats', cards: ['derivatives.options-stats', 'derivatives.options-oi-strike'] },
      { id: 'term', title: 'Term structure', cards: ['derivatives.options-term-structure'] },
      { id: 'smile', title: 'Smile & surface', cards: ['derivatives.options-smile', 'derivatives.options-surface'] },
      { id: 'volatility', title: 'Volatility', cards: ['derivatives.options-gamma', 'derivatives.options-vol-cone'] },
      { id: 'strategies', title: 'Strategies', cards: ['derivatives.options-strategies', 'derivatives.options-payoff'] },
    ],
  },
  {
    id: 'futures',
    title: 'Futures & Positioning',
    group: 'Derivatives',
    tabs: [
      {
        id: 'futures',
        title: 'Futures',
        cards: ['derivatives.vix-futures', 'derivatives.futures-board', 'derivatives.fed-funds-futures', 'derivatives.wti-curve'],
      },
      { id: 'positioning', title: 'Positioning', cards: ['derivatives.cot-financial', 'derivatives.cot-history'] },
    ],
  },
  {
    id: 'crypto',
    title: 'Crypto',
    group: 'Crypto',
    tabs: [
      { id: 'spot', title: 'Spot', cards: ['derivatives.crypto-spot', 'derivatives.crypto-history'] },
      { id: 'book', title: 'Order book', cards: ['derivatives.crypto-order-book'] },
      { id: 'options', title: 'Options', cards: ['derivatives.crypto-options', 'derivatives.crypto-options-expiries'] },
      { id: 'volatility', title: 'Volatility', cards: ['derivatives.crypto-smile', 'derivatives.crypto-surface', 'derivatives.crypto-dvol'] },
      { id: 'funding', title: 'Funding', cards: ['derivatives.crypto-funding', 'derivatives.crypto-basis'] },
    ],
  },
];

/** Jump targets for a typed query: a coin, a Commitments of Traders contract, or a ticker's option chain. */
export function derivativesSearch(query: string): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  const coin = cryptoCurrency(q);
  if (coin) {
    hits.push({ kind: 'security', label: `${coin} spot`, detail: 'Crypto', dashboard: 'crypto', tab: 'spot', params: { symbol: `${coin}-USD` } });
    hits.push({ kind: 'security', label: `${coin} options (Deribit)`, detail: 'Crypto', dashboard: 'crypto', tab: 'options', params: { currency: coin } });
  }
  const lower = q.toLowerCase();
  for (const m of COT_MARKETS) {
    if (lower.length >= 3 && (m.label.toLowerCase().includes(lower) || m.id === lower)) {
      hits.push({ kind: 'dataset', label: `${m.label} futures positioning`, detail: 'CFTC Commitments of Traders', dashboard: 'futures', tab: 'positioning', params: { series: m.id } });
    }
  }
  // "aapl options", "spy option chain": a bare ticker is left to the equities search.
  const opt = /^([A-Za-z]{1,5}(?:[.-][A-Za-z]{1,2})?)\s+options?(\s+chain)?$/.exec(q);
  if (opt) {
    const symbol = opt[1].toUpperCase();
    hits.push({ kind: 'security', label: `${symbol} options`, detail: 'Equity Options', dashboard: 'options', tab: 'chain', params: { symbol } });
  }
  return hits;
}

export const derivatives: AreaModule = {
  cards: [...optionCards, ...optionVolCards, ...futuresCards, ...cryptoCards, ...cryptoVolCards],
  dashboards,
  search: async (_ctx, query) => derivativesSearch(query),
};
