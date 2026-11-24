/** Currencies, commodities, energy and agriculture. */
import type { AreaModule, DashboardDef } from '../../types.js';
import { agriBalanceCards, agriFarmCards } from './agri.js';
import { agriBoard, agriFuturesBoard, agriFuturesCurve, agriHistory, commodityBoardCards, commodityCurveCards } from './boards.js';
import { energyGasCards, energyOilCards } from './energy-oil.js';
import { energyIntlCards, energyOutlookCards, energyPowerCards } from './energy-power.js';
import { energyPriceCards } from './energy-prices.js';
import { fxCrossCards, fxMarketCards, fxStrengthCards } from './fx.js';
import { fxRatesCards, fxReserveCards } from './fx-macro.js';
import { agriPositioning, commodityPositioning, fxPositioning } from './positioning.js';
import { searchCommodities } from './search.js';

const ids = (cards: { id: string }[]): string[] => cards.map((c) => c.id);

const agriBoardCards = [agriBoard, agriHistory, agriFuturesBoard, agriFuturesCurve];

const dashboards: DashboardDef[] = [
  {
    id: 'fx',
    title: 'Currencies',
    group: 'Currencies',
    tabs: [
      { id: 'board', title: 'Board', cards: ids(fxMarketCards) },
      { id: 'strength', title: 'Strength', cards: ids(fxStrengthCards) },
      { id: 'cross', title: 'Cross rates', cards: ids(fxCrossCards) },
      { id: 'rates', title: 'Rates & differentials', cards: ids(fxRatesCards) },
      { id: 'reer', title: 'REER & reserves', cards: ids(fxReserveCards) },
      { id: 'positioning', title: 'Positioning', cards: [fxPositioning.id] },
    ],
  },
  {
    id: 'commodities',
    title: 'Commodities',
    group: 'Commodities & Energy',
    tabs: [
      { id: 'boards', title: 'Boards', cards: ids(commodityBoardCards) },
      { id: 'curves', title: 'Curves', cards: ids(commodityCurveCards) },
      { id: 'positioning', title: 'Positioning', cards: [commodityPositioning.id] },
    ],
  },
  {
    id: 'energy',
    title: 'Energy',
    group: 'Commodities & Energy',
    tabs: [
      { id: 'overview', title: 'Overview', cards: ids(energyPriceCards) },
      { id: 'oil', title: 'Oil', cards: ids(energyOilCards) },
      { id: 'gas', title: 'Natural gas', cards: ids(energyGasCards) },
      { id: 'power', title: 'Power', cards: ids(energyPowerCards) },
      { id: 'outlook', title: 'Outlook', cards: ids(energyOutlookCards) },
      { id: 'international', title: 'International', cards: ids(energyIntlCards) },
    ],
  },
  {
    id: 'agri',
    title: 'Agriculture & Food',
    group: 'Commodities & Energy',
    tabs: [
      { id: 'boards', title: 'Boards and curves', cards: ids(agriBoardCards) },
      { id: 'positioning', title: 'Positioning', cards: [agriPositioning.id] },
      { id: 'balances', title: 'Balances', cards: ids(agriBalanceCards) },
      { id: 'farm', title: 'Farm data', cards: ids(agriFarmCards) },
    ],
  },
];

export const commodities: AreaModule = {
  cards: [
    ...fxMarketCards,
    ...fxStrengthCards,
    ...fxCrossCards,
    ...fxRatesCards,
    ...fxReserveCards,
    fxPositioning,
    ...commodityBoardCards,
    ...commodityCurveCards,
    commodityPositioning,
    ...energyPriceCards,
    ...energyOilCards,
    ...energyGasCards,
    ...energyPowerCards,
    ...energyOutlookCards,
    ...energyIntlCards,
    ...agriBoardCards,
    agriPositioning,
    ...agriBalanceCards,
    ...agriFarmCards,
  ],
  dashboards,
  search: searchCommodities,
};
