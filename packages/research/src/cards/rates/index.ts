/** Rates & Credit area: Rates & Curves, Credit, Government Finance, and Money & Banking. */
import type { AreaModule, CardDef, DashboardDef, SearchHit, SearchProvider } from '../../types.js';
import { bankingCards } from './banking.js';
import { creditCards } from './credit.js';
import { DAILY_CURVE_COUNTRIES } from './curves.js';
import { govfinCards } from './govfin.js';
import { countryCards } from './rates-country.js';
import { euroCards, moneyMarketCards } from './rates-euro-mm.js';
import { swapPolicyCards } from './rates-swaps-policy.js';
import { usCards } from './rates-us.js';
import { COUNTRIES } from './util.js';

const cards: CardDef[] = [...countryCards, ...usCards, ...euroCards, ...moneyMarketCards, ...swapPolicyCards, ...creditCards, ...govfinCards, ...bankingCards];

const dashboards: DashboardDef[] = [
  {
    id: 'rates',
    title: 'Rates & Curves',
    group: 'Rates & Credit',
    tabs: [
      { id: 'global', title: 'Global', cards: ['rates.global-yields', 'rates.policy-rates'] },
      { id: 'country', title: 'By Country', cards: ['rates.curve', 'rates.curve-changes', 'rates.policy-history', 'rates.long-rate-history'] },
      { id: 'us', title: 'U.S.', cards: ['rates.us-curve-history', 'rates.us-real-yields', 'rates.us-bills', 'rates.us-breakevens'] },
      { id: 'euro', title: 'Euro area', cards: ['rates.ea-curve', 'rates.ecb-key-rates', 'rates.estr'] },
      { id: 'money-markets', title: 'Money markets', cards: ['rates.reference-rates', 'rates.reference-rates-history', 'rates.sofr-averages', 'rates.repo-operations'] },
      { id: 'swaps', title: 'Swaps & OIS', cards: ['rates.swap-trades'] },
      { id: 'policy', title: 'Policy Expectations', cards: ['rates.fomc-statement', 'rates.fomc-documents'] },
    ],
  },
  {
    id: 'credit',
    title: 'Credit',
    group: 'Rates & Credit',
    tabs: [
      { id: 'spreads', title: 'Spreads', cards: ['credit.cds-indices', 'credit.oas-ratings', 'credit.oas-regions'] },
      { id: 'bonds', title: 'Bond Lookup', cards: ['credit.bond-pricer', 'credit.maturity-wall'] },
      { id: 'private', title: 'Private credit', cards: ['credit.bdcs', 'credit.loan-clo-etfs', 'credit.alt-managers'] },
      { id: 'lending', title: 'Corporate debt & lending', cards: ['credit.sloos', 'credit.corporate-leverage'] },
    ],
  },
  {
    id: 'govfin',
    title: 'Government Finance',
    group: 'Rates & Credit',
    tabs: [
      { id: 'debt', title: 'Public debt', cards: ['govfin.debt-to-penny', 'govfin.debt-by-holder', 'govfin.avg-interest-rates'] },
      { id: 'cash', title: 'Treasury cash balance', cards: ['govfin.tga'] },
      { id: 'auctions', title: 'Auctions', cards: ['govfin.auction-results', 'govfin.auctions-upcoming'] },
      { id: 'fed', title: 'Fed balance sheet', cards: ['govfin.fed-balance-sheet'] },
      { id: 'dealers', title: 'Primary dealers', cards: ['govfin.primary-dealers'] },
    ],
  },
  {
    id: 'banking',
    title: 'Money & Banking',
    group: 'Macro & Economy',
    tabs: [
      { id: 'quality', title: 'Bank credit quality', cards: ['banking.credit-quality'] },
      { id: 'failures', title: 'Bank failures', cards: ['banking.failures'] },
      { id: 'lookup', title: 'Bank lookup', cards: ['banking.bank-lookup'] },
      { id: 'liquidity', title: 'Fed and ECB liquidity', cards: ['banking.ecb-liquidity', 'banking.fed-liquidity'] },
    ],
  },
];

/** Country names and codes jump to the By Country tab; "<name> bank" style queries are left to the registry. */
export function searchRates(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const c of COUNTRIES) {
    const byCode = q.length === 2 && c.iso2.toLowerCase() === q;
    const byName = q.length >= 3 && c.name.toLowerCase().includes(q);
    if (!byCode && !byName) continue;
    const daily = DAILY_CURVE_COUNTRIES.includes(c.iso2);
    hits.push({
      kind: 'dataset',
      label: `${c.name} yield curve and policy rate`,
      detail: daily ? 'Rates & Curves > By Country (official daily curve)' : 'Rates & Curves > By Country (monthly OECD rates)',
      dashboard: 'rates',
      tab: 'country',
      params: { country: c.iso2 },
    });
  }
  return hits.slice(0, 5);
}

const search: SearchProvider = (_ctx, query) => Promise.resolve(searchRates(query));

export const rates: AreaModule = { cards, dashboards, search };
