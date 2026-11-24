/** Every area module, in sidebar order. */
import { Registry } from '../registry.js';
import type { AreaModule } from '../types.js';
import { commodities } from './commodities/index.js';
import { derivatives } from './derivatives/index.js';
import { equities } from './equities/index.js';
import { macro } from './macro/index.js';
import { overview } from './overview/index.js';
import { rates } from './rates/index.js';

export const AREAS: AreaModule[] = [overview, equities, rates, derivatives, commodities, macro];

/** Sidebar group order. Groups not listed sort after these, alphabetically. */
export const GROUP_ORDER = [
  'Overview',
  'Equities',
  'Indices, ETFs & Factors',
  'Rates & Credit',
  'Derivatives',
  'Currencies',
  'Commodities & Energy',
  'Crypto',
  'Macro & Economy',
  'Government & Regulation',
  'News & Research',
];

let shared: Registry | undefined;

/** The one registry with every card and dashboard. */
export function registry(): Registry {
  if (!shared) {
    shared = new Registry(AREAS);
    const rank = (g: string) => {
      const i = GROUP_ORDER.indexOf(g);
      return i < 0 ? GROUP_ORDER.length : i;
    };
    shared.dashboards.sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group));
  }
  return shared;
}
