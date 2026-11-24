/** Macro area: economy dashboards, trade and shipping, data explorers, government and news. */
import type { AreaModule } from '../../types.js';
import { economyCards, economyDashboard } from './economy.js';
import { explorerCards, explorersDashboard } from './explorers.js';
import { governmentCards, governmentDashboards } from './government.js';
import { newsCards, newsDashboard } from './news.js';
import { search } from './search.js';
import { tradeCards, tradeDashboard } from './trade.js';
import { usActivityCards, usEconomyDashboard } from './us-activity.js';
import { usBlsCards } from './us-bls.js';

export const macro: AreaModule = {
  cards: [...economyCards, ...usActivityCards, ...usBlsCards, ...tradeCards, ...explorerCards, ...governmentCards, ...newsCards],
  dashboards: [economyDashboard('macro.news-regional'), usEconomyDashboard, tradeDashboard, explorersDashboard, ...governmentDashboards, newsDashboard],
  search,
};
