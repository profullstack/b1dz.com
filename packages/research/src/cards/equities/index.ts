/** Equities, indices, ETFs, factors and SEC research. */
import type { AreaModule, CardDef, DashboardDef } from '../../types.js';
import { bankCards } from './company-bank.js';
import { estimateCards } from './company-estimates.js';
import { financialCards } from './company-financials.js';
import { overviewCards } from './company-overview.js';
import { ownershipCards } from './company-ownership.js';
import { peerCards } from './company-peers.js';
import { etfCards } from './etfs.js';
import { factorCards } from './factors.js';
import { indexCards } from './indices.js';
import { canadaCards, nordicCards } from './markets.js';
import { calendarCards, screenerCards } from './screeners.js';
import { search } from './search.js';
import { secCards } from './sec-research.js';

const cards: CardDef[] = [
  ...overviewCards,
  ...financialCards,
  ...estimateCards,
  ...peerCards,
  ...ownershipCards,
  ...bankCards,
  ...screenerCards,
  ...calendarCards,
  ...canadaCards,
  ...nordicCards,
  ...indexCards,
  ...etfCards,
  ...factorCards,
  ...secCards,
];

const EQUITIES = 'Equities';
const INDICES = 'Indices, ETFs & Factors';
const NEWS = 'News & Research';

const dashboards: DashboardDef[] = [
  {
    id: 'company',
    title: 'Company',
    group: EQUITIES,
    tabs: [
      { id: 'overview', title: 'Overview', cards: ['equities.price-history', 'equities.snapshot', 'equities.analyst-targets', 'equities.rating-changes', 'equities.news'] },
      { id: 'statements', title: 'Statements', cards: ['equities.income-statement', 'equities.balance-sheet', 'equities.cash-flow'] },
      { id: 'estimates', title: 'Estimates', cards: ['equities.earnings', 'equities.surprise-history', 'equities.estimate-revisions', 'equities.earnings-release'] },
      { id: 'peers', title: 'Price & Peers', cards: ['equities.comps', 'equities.risk-peers'] },
      { id: 'ratios', title: 'Growth & Ratios', cards: ['equities.valuation-history', 'equities.roic', 'equities.dupont'] },
      { id: 'ownership', title: 'Ownership', cards: ['equities.insiders', 'equities.institutions'] },
      { id: 'dividends', title: 'Dividends', cards: ['equities.dividends'] },
      { id: 'filings', title: 'Filings', cards: ['equities.filings', 'equities.filing-sections'] },
      { id: 'shorts', title: 'Shorts', cards: ['equities.short-interest'] },
      { id: 'bank', title: 'Bank quality', cards: ['equities.bank-quality'] },
    ],
  },
  {
    id: 'screeners',
    title: 'Screeners & Movers',
    group: EQUITIES,
    tabs: [
      { id: 'movers', title: 'Movers', cards: ['equities.most-active', 'equities.gainers', 'equities.losers'] },
      { id: 'screener', title: 'Screener', cards: ['equities.screener'] },
    ],
  },
  {
    id: 'calendars',
    title: 'Calendars & Events',
    group: EQUITIES,
    tabs: [
      { id: 'earnings', title: 'Earnings', cards: ['equities.earnings-calendar'] },
      { id: 'dividends', title: 'Dividends', cards: ['equities.dividend-calendar'] },
      { id: 'ipos', title: 'IPOs & Splits', cards: ['equities.ipo-calendar', 'equities.splits-calendar'] },
      { id: 'economic', title: 'Economic events', cards: ['equities.economic-calendar'] },
    ],
  },
  {
    id: 'canada',
    title: 'Canada (TMX)',
    group: EQUITIES,
    tabs: [
      { id: 'market', title: 'Market', cards: ['equities.canada-indices', 'equities.canada-board'] },
      { id: 'listing', title: 'Listing', cards: ['equities.canada-quote'] },
    ],
  },
  {
    id: 'nordics',
    title: 'Nordics (Nasdaq Nordic)',
    group: EQUITIES,
    tabs: [
      { id: 'indices', title: 'Indices', cards: ['equities.nordic-indices'] },
      { id: 'shares', title: 'Shares', cards: ['equities.nordic-shares'] },
    ],
  },
  {
    id: 'indices',
    title: 'Indices',
    group: INDICES,
    tabs: [
      { id: 'world', title: 'World', cards: ['equities.world-indices', 'equities.country-etfs'] },
      { id: 'sectors', title: 'U.S. sectors', cards: ['equities.us-sectors'] },
      { id: 'constituents', title: 'Constituents', cards: ['equities.index-constituents'] },
      { id: 'long-run', title: 'S&P 500 long run', cards: ['equities.sp500-long-run'] },
    ],
  },
  {
    id: 'etfs',
    title: 'ETFs & Funds',
    group: INDICES,
    tabs: [
      { id: 'profile', title: 'Profile', cards: ['equities.etf-profile', 'equities.etf-holdings'] },
      { id: 'weights', title: 'Weights', cards: ['equities.etf-sectors'] },
      { id: 'overlap', title: 'Overlap', cards: ['equities.etf-overlap'] },
      { id: 'filings', title: 'N-PORT filings', cards: ['equities.etf-nport'] },
    ],
  },
  {
    id: 'factors',
    title: 'Factors & Styles',
    group: INDICES,
    tabs: [
      { id: 'factors', title: 'Factors', cards: ['equities.factor-board', 'equities.style-box'] },
      { id: 'cross-asset', title: 'Cross-asset risk', cards: ['equities.correlations', 'equities.risk-stats'] },
      { id: 'rotation', title: 'Rotation', cards: ['equities.rotation'] },
    ],
  },
  {
    id: 'sec',
    title: 'SEC Filings & Enforcement',
    group: NEWS,
    tabs: [
      { id: 'search', title: 'Search', cards: ['equities.sec-search', 'equities.sec-filing'] },
      { id: 'latest', title: 'Latest filings', cards: ['equities.sec-latest'] },
      { id: 'enforcement', title: 'Enforcement & news', cards: ['equities.sec-litigation', 'equities.sec-press'] },
      { id: 'advisers', title: 'Advisers', cards: ['equities.sec-adv'] },
    ],
  },
];

export const equities: AreaModule = { cards, dashboards, search };
