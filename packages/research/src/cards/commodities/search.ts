/** Search for this area: currency codes and pairs, commodity names, and the datasets behind the energy and farm tabs. */
import type { SearchHit, SearchProvider } from '../../types.js';
import { AREAS } from './bis.js';
import { CURRENCY_NAMES } from './fx-data.js';
import { PCPS } from './imf.js';

const AGRI_CODES = new Set(['PMAIZMT', 'PWHEAMT', 'PSOYB', 'PRICENPQ', 'PSMEA', 'PSOIL', 'PPOIL', 'PSUGAISA', 'PCOFFOTM', 'PCOFFROB', 'PCOCO', 'PCOTTIND', 'PORANG', 'PBEEF', 'PPORK', 'PPOULT', 'PUREA', 'PDAP', 'PPOTASH']);
const HISTORY_CODES = new Set(['PGOLD', 'PSILVER', 'PPLAT', 'PPALLA', 'PCOPP', 'PALUM', 'PNICK', 'PZINC', 'PLEAD', 'PTIN', 'PIORECR', 'PCOBA', 'POILBRE', 'POILWTI', 'POILDUB', 'PNGASUS', 'PNGASEU', 'PNGASJP', 'PCOALAU', 'PURAN']);

/** Topics that jump straight to a tab. */
const TOPICS: { words: string[]; hit: SearchHit }[] = [
  { words: ['wti', 'brent', 'crude', 'oil price'], hit: { kind: 'dataset', label: 'Crude oil: WTI, Brent and the spread', detail: 'Energy > Overview', dashboard: 'energy', tab: 'overview' } },
  { words: ['crack', 'refining margin', '3-2-1'], hit: { kind: 'dataset', label: 'Refining margins: crack spreads', detail: 'Energy > Overview', dashboard: 'energy', tab: 'overview' } },
  { words: ['inventor', 'stocks', 'cushing', 'spr', 'gasoline', 'distillate', 'refinery'], hit: { kind: 'dataset', label: 'U.S. petroleum inventories', detail: 'Energy > Oil', dashboard: 'energy', tab: 'oil' } },
  { words: ['storage', 'lng', 'natural gas', 'natgas', 'henry hub'], hit: { kind: 'dataset', label: 'U.S. natural gas storage and LNG exports', detail: 'Energy > Natural gas', dashboard: 'energy', tab: 'gas' } },
  { words: ['grid', 'electricity', 'power demand', 'nuclear', 'generation'], hit: { kind: 'dataset', label: 'U.S. grid demand, fuel mix and nuclear outages', detail: 'Energy > Power', dashboard: 'energy', tab: 'power' } },
  { words: ['steo', 'energy outlook', 'forecast'], hit: { kind: 'dataset', label: 'Short-Term Energy Outlook forecasts', detail: 'Energy > Outlook', dashboard: 'energy', tab: 'outlook' } },
  { words: ['opec', 'oil production', 'oil exports'], hit: { kind: 'dataset', label: 'Crude oil production and exports by country', detail: 'Energy > International', dashboard: 'energy', tab: 'international' } },
  { words: ['wasde', 'stocks-to-use', 'psd', 'ending stocks', 'balance'], hit: { kind: 'dataset', label: 'World grain and oilseed balances (WASDE)', detail: 'Agriculture & Food > Balances', dashboard: 'agri', tab: 'balances' } },
  { words: ['cot', 'commitments of traders', 'managed money', 'positioning'], hit: { kind: 'dataset', label: 'Commodity futures positioning (CFTC)', detail: 'Commodities > Positioning', dashboard: 'commodities', tab: 'positioning' } },
  { words: ['reer', 'effective exchange'], hit: { kind: 'dataset', label: 'Real and nominal effective exchange rates', detail: 'Currencies > REER & reserves', dashboard: 'fx', tab: 'reer' } },
  { words: ['reserves', 'cofer'], hit: { kind: 'dataset', label: 'Official reserves and their currency composition', detail: 'Currencies > REER & reserves', dashboard: 'fx', tab: 'reer' } },
  { words: ['policy rate', 'central bank rate', 'carry'], hit: { kind: 'dataset', label: 'Policy rates and differentials versus the U.S.', detail: 'Currencies > Rates & differentials', dashboard: 'fx', tab: 'rates' } },
];

export function searchStatic(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: SearchHit[] = [];
  const codes = new Set(Object.keys(CURRENCY_NAMES));

  // A pair: EURUSD, eur/usd, usd jpy.
  const pair = /^([a-z]{3})[\s/-]?([a-z]{3})(=x)?$/.exec(q);
  if (pair && codes.has(pair[1].toUpperCase()) && codes.has(pair[2].toUpperCase()) && pair[1] !== pair[2]) {
    const symbol = `${pair[1]}${pair[2]}`.toUpperCase();
    out.push({ kind: 'security', label: symbol, detail: 'Currency pair: spot against the policy-rate differential', dashboard: 'fx', tab: 'rates', params: { symbol } });
  }
  // One currency, by code or name.
  for (const [code, name] of Object.entries(CURRENCY_NAMES)) {
    if (code === 'USD') continue;
    if (code.toLowerCase() === q || (q.length >= 3 && name.toLowerCase().includes(q))) {
      const symbol = ['EUR', 'GBP', 'AUD', 'NZD'].includes(code) ? `${code}USD` : `USD${code}`;
      out.push({ kind: 'security', label: `${symbol} (${name})`, detail: 'Currencies > Rates & differentials', dashboard: 'fx', tab: 'rates', params: { symbol } });
      const area = AREAS.find((a) => a.currency === code);
      if (area) out.push({ kind: 'dataset', label: `${area.name}: effective exchange rate`, detail: 'Currencies > REER & reserves', dashboard: 'fx', tab: 'reer', params: { country: area.code === 'XM' ? 'EU' : area.code } });
    }
  }
  // Commodities by name.
  if (q.length >= 3) {
    for (const item of Object.values(PCPS)) {
      if (!item.name.toLowerCase().includes(q)) continue;
      if (AGRI_CODES.has(item.code)) out.push({ kind: 'security', label: `${item.name} (${item.unit})`, detail: 'Agriculture & Food > Boards and curves', dashboard: 'agri', tab: 'boards', params: { series: item.code } });
      else if (HISTORY_CODES.has(item.code)) out.push({ kind: 'security', label: `${item.name} (${item.unit})`, detail: 'Commodities > Boards', dashboard: 'commodities', tab: 'boards', params: { series: item.code } });
    }
    for (const t of TOPICS) if (t.words.some((w) => w.includes(q) || q.includes(w))) out.push(t.hit);
  }
  return out.slice(0, 12);
}

export const searchCommodities: SearchProvider = async (_ctx, query) => searchStatic(query);
