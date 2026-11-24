/** Search for the macro area: dataset keywords and country names jump to the right dashboard and tab. Navigation only, no data. */
import type { SearchHit, SearchProvider } from '../../types.js';
import { findCountries } from './countries.js';

interface Topic {
  /** Lower-case words or phrases that select this topic. */
  keys: string[];
  label: string;
  detail: string;
  dashboard: string;
  tab: string;
  params?: Record<string, string>;
}

/**
 * A few datasets people look for under "macro" live in other areas'
 * dashboards (`rates`, `agri`, `energy`); those topics point there by id.
 */
export const TOPICS: Topic[] = [
  { keys: ['cpi', 'consumer price', 'consumer prices', 'inflation', 'core cpi'], label: 'U.S. CPI', detail: 'BLS consumer price index, 12-month changes', dashboard: 'us-economy', tab: 'prices' },
  { keys: ['ppi', 'producer price', 'producer prices', 'wholesale prices'], label: 'U.S. PPI', detail: 'BLS producer price index', dashboard: 'us-economy', tab: 'prices' },
  { keys: ['payrolls', 'nonfarm', 'nfp', 'jobs', 'jobs report', 'employment', 'unemployment', 'jolts', 'job openings', 'quits', 'wages', 'hourly earnings', 'participation'], label: 'U.S. labor market', detail: 'Payrolls, unemployment, earnings and JOLTS', dashboard: 'us-economy', tab: 'labor' },
  { keys: ['gdp', 'gdpnow', 'nowcast', 'nowcasts', 'growth'], label: 'U.S. GDP nowcast', detail: 'Atlanta Fed GDPNow and Cleveland Fed inflation nowcast', dashboard: 'us-economy', tab: 'nowcasts' },
  { keys: ['pce', 'inflation nowcast', 'core pce'], label: 'Inflation nowcast', detail: 'Cleveland Fed CPI and PCE nowcast', dashboard: 'us-economy', tab: 'nowcasts' },
  { keys: ['housing', 'housing starts', 'starts', 'permits', 'building permits', 'mortgage', 'mortgage rates', 'home prices', 'case-shiller', 'case shiller', 'new home sales', 'cre'], label: 'U.S. housing', detail: 'Mortgage rates, starts, permits and home prices', dashboard: 'us-economy', tab: 'housing' },
  { keys: ['empire', 'empire state', 'philly fed', 'philadelphia fed', 'regional fed', 'manufacturing survey', 'business survey', 'ism', 'pmi'], label: 'Regional Fed surveys', detail: 'New York and Philadelphia Fed manufacturing indexes', dashboard: 'us-economy', tab: 'surveys' },
  { keys: ['gdp', 'world economy', 'country monitor', 'economies', 'policy rate', 'policy rates', 'central bank rates', 'interest rates'], label: 'Country Monitor', detail: 'Growth, inflation, policy rate and yields for 17 economies', dashboard: 'economy', tab: 'monitor' },
  { keys: ['oecd', 'leading indicator', 'leading indicators', 'cli'], label: 'OECD snapshot', detail: 'Leading indicators, unemployment and CPI by country', dashboard: 'economy', tab: 'oecd' },
  { keys: ['current account', 'external accounts', 'balance of payments', 'government debt', 'debt to gdp', 'deficit', 'fiscal'], label: 'External and fiscal balances', detail: 'Current account, debt and deficit as a share of GDP', dashboard: 'economy', tab: 'external' },
  { keys: ['imf', 'weo', 'world economic outlook', 'forecast', 'forecasts', 'projections'], label: 'IMF forecasts', detail: 'World Economic Outlook projections by country', dashboard: 'economy', tab: 'forecasts' },
  { keys: ['shipping', 'chokepoint', 'chokepoints', 'hormuz', 'suez', 'red sea', 'bab el-mandeb', 'panama canal', 'malacca', 'bosporus', 'taiwan strait', 'cape of good hope', 'tankers', 'portwatch'], label: 'Maritime chokepoints', detail: 'Daily vessel transits from IMF PortWatch', dashboard: 'trade', tab: 'chokepoints' },
  { keys: ['ports', 'port', 'port calls', 'container', 'containers', 'disruptions'], label: 'Major ports', detail: 'Port calls, trade volume estimates and disruptions', dashboard: 'trade', tab: 'ports' },
  { keys: ['trade', 'imports', 'exports', 'trade balance', 'trade deficit', 'tariff', 'tariffs', 'comtrade', 'trading partners'], label: 'Trade partners', detail: 'Bilateral goods trade from UN Comtrade', dashboard: 'trade', tab: 'trade' },
  { keys: ['fred', 'bls', 'ecb', 'bis', 'data', 'series', 'explorer', 'dataset', 'datasets'], label: 'Data Explorers', detail: 'Search and plot FRED, BLS, IMF, OECD, ECB and BIS series', dashboard: 'explorers', tab: 'search' },
  { keys: ['congress', 'bill', 'bills', 'legislation', 'house', 'senate'], label: 'Bills in Congress', detail: 'Latest bills and their latest action', dashboard: 'congress', tab: 'bills' },
  { keys: ['law', 'laws', 'public law', 'enacted'], label: 'Recently enacted laws', detail: 'Bills that became public law', dashboard: 'congress', tab: 'laws' },
  { keys: ['vote', 'votes', 'roll call'], label: 'House roll-call votes', detail: 'Recent recorded House votes', dashboard: 'congress', tab: 'votes' },
  { keys: ['members', 'senators', 'representatives', 'delegation'], label: 'Members of Congress by state', detail: 'Current senators and representatives', dashboard: 'congress', tab: 'members' },
  { keys: ['hearing', 'hearings', 'committee', 'committees'], label: 'Committee calendar', detail: 'Scheduled Senate hearings', dashboard: 'congress', tab: 'committees' },
  { keys: ['spending', 'federal spending', 'budget', 'agencies', 'usaspending', 'obligations', 'outlays'], label: 'Federal spending by agency', detail: 'Budgetary resources, obligations and outlays', dashboard: 'spending', tab: 'agencies' },
  { keys: ['contracts', 'awards', 'contract awards', 'procurement'], label: 'Federal contract awards', detail: 'Largest new contracts', dashboard: 'spending', tab: 'awards' },
  { keys: ['recipients', 'contractors', 'grants'], label: 'Top federal recipients', detail: 'Who receives the most award money', dashboard: 'spending', tab: 'recipients' },
  { keys: ['news', 'headlines', 'markets news'], label: 'Market headlines', detail: 'Merged publisher feeds', dashboard: 'news', tab: 'markets' },
  { keys: ['fed', 'fomc', 'federal reserve', 'press releases', 'speeches', 'central banks', 'official', 'treasury', 'sec', 'bea', 'boe', 'boj'], label: 'Official releases', detail: 'Central banks, regulators and statistical agencies', dashboard: 'news', tab: 'official' },
  { keys: ['8-k', '8k', 'company news'], label: 'Company news', detail: 'Headlines and 8-K filings for a ticker', dashboard: 'news', tab: 'company' },
  // Datasets that live in other areas' dashboards.
  { keys: ['sofr', 'effr', 'fed funds', 'repo', 'money markets', 'reference rates'], label: 'SOFR and money-market rates', detail: 'Rates dashboard, money markets', dashboard: 'rates', tab: 'money-markets' },
  { keys: ['treasury yields', 'yield curve', 'treasuries', 'yields'], label: 'U.S. Treasury yields', detail: 'Rates dashboard, U.S.', dashboard: 'rates', tab: 'us' },
  { keys: ['wasde', 'crop', 'crops', 'grains', 'corn', 'wheat', 'soybeans', 'usda'], label: 'WASDE and crop balances', detail: 'Agriculture dashboard, balances', dashboard: 'agri', tab: 'balances' },
  { keys: ['eia', 'oil inventories', 'crude stocks', 'petroleum'], label: 'Oil inventories', detail: 'Energy dashboard, oil', dashboard: 'energy', tab: 'oil' },
];

function score(topic: Topic, q: string): number {
  let best = 0;
  for (const k of topic.keys) {
    if (k === q) best = Math.max(best, 3);
    else if (q.length >= 3 && k.startsWith(q)) best = Math.max(best, 2);
    else if (q.length >= 4 && (k.includes(q) || q.includes(k))) best = Math.max(best, 1);
  }
  return best;
}

/**
 * Hits for a query, best first. A country name returns the country pages
 * with `country` set. When `known` is given, hits to dashboards outside it
 * are dropped.
 */
export function macroHits(query: string, known?: ReadonlySet<string>): SearchHit[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const c of findCountries(q).slice(0, 3)) {
    const params = { country: c.iso2 };
    hits.push({ kind: 'dataset', label: `${c.name}: economy`, detail: 'Inflation, policy rate and news', dashboard: 'economy', tab: 'monitor', params });
    hits.push({ kind: 'dataset', label: `${c.name}: IMF forecasts`, detail: 'World Economic Outlook projections', dashboard: 'economy', tab: 'forecasts', params });
    hits.push({ kind: 'dataset', label: `${c.name}: news`, detail: 'Economy and markets headlines', dashboard: 'news', tab: 'regional', params });
    if (c.iso2 !== 'XM') hits.push({ kind: 'dataset', label: `${c.name}: trade partners`, detail: 'Goods trade by partner', dashboard: 'trade', tab: 'trade', params });
  }
  const ranked = TOPICS.map((t) => ({ t, s: score(t, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  for (const { t } of ranked) {
    const hit: SearchHit = { kind: 'dataset', label: t.label, detail: t.detail, dashboard: t.dashboard };
    if (t.tab) hit.tab = t.tab;
    if (t.params) hit.params = t.params;
    hits.push(hit);
  }
  return known ? hits.filter((h) => known.has(h.dashboard)) : hits;
}

/** Dashboards this area defines; hits that point at another area's dashboard are kept only for the ids listed in EXTERNAL. */
const OWN = new Set(['economy', 'us-economy', 'trade', 'explorers', 'congress', 'spending', 'news']);
const EXTERNAL = new Set(['rates', 'agri', 'energy']);

export const search: SearchProvider = async (_ctx, query) => macroHits(query, new Set([...OWN, ...EXTERNAL])).slice(0, 12);
