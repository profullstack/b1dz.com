/**
 * The EIA requests shared by several cards. Each is one fixed URL (the start
 * date only moves once a month) so the energy dashboard and the commodity
 * boards reuse one cached response instead of spending the demo key twice.
 */
import type { Ctx } from '../../types.js';
import { eiaData, type EiaRow } from './eia.js';
import { monthStartBack } from './util.js';

/** Daily spot prices, petroleum/pri/spt. */
export const SPOT = {
  wti: { id: 'RWTC', name: 'WTI, Cushing', unit: 'USD/bbl' },
  brent: { id: 'RBRTE', name: 'Brent, Europe', unit: 'USD/bbl' },
  gasoline: { id: 'EER_EPMRU_PF4_Y35NY_DPG', name: 'Gasoline, New York Harbor', unit: 'USD/gal' },
  ulsd: { id: 'EER_EPD2DXL0_PF4_Y35NY_DPG', name: 'Diesel (ULSD), New York Harbor', unit: 'USD/gal' },
  heating: { id: 'EER_EPD2F_PF4_Y35NY_DPG', name: 'Heating oil, New York Harbor', unit: 'USD/gal' },
  jet: { id: 'EER_EPJK_PF4_RGC_DPG', name: 'Jet fuel, U.S. Gulf Coast', unit: 'USD/gal' },
  propane: { id: 'EER_EPLLPA_PF4_Y44MB_DPG', name: 'Propane, Mont Belvieu', unit: 'USD/gal' },
} as const;

export function petroleumSpot(ctx: Ctx): Promise<EiaRow[]> {
  return eiaData(ctx, 'petroleum/pri/spt', {
    frequency: 'daily',
    facets: { series: Object.values(SPOT).map((s) => s.id) },
    start: monthStartBack(ctx.now(), 24),
    ttl: 3600,
  });
}

/** Henry Hub daily spot and the four nearest NYMEX contracts, natural-gas/pri/fut. */
export const GAS = {
  spot: { id: 'RNGWHHD', name: 'Henry Hub spot', unit: 'USD/MMBtu' },
  contracts: ['RNGC1', 'RNGC2', 'RNGC3', 'RNGC4'],
} as const;

export function gasPrices(ctx: Ctx): Promise<EiaRow[]> {
  return eiaData(ctx, 'natural-gas/pri/fut', {
    frequency: 'daily',
    facets: { series: [GAS.spot.id, ...GAS.contracts] },
    start: monthStartBack(ctx.now(), 24),
    ttl: 3600,
  });
}

/** Weekly Petroleum Status Report series, petroleum/sum/sndw: six years so a five-year band can be computed. */
export const WEEKLY = {
  crude: { id: 'WCESTUS1', label: 'Commercial crude stocks', unit: 'mb', scale: 0.001, digits: 1 },
  spr: { id: 'WCSSTUS1', label: 'Strategic Petroleum Reserve', unit: 'mb', scale: 0.001, digits: 1 },
  cushing: { id: 'W_EPC0_SAX_YCUOK_MBBL', label: 'Cushing, OK crude stocks', unit: 'mb', scale: 0.001, digits: 1 },
  gasoline: { id: 'WGTSTUS1', label: 'Gasoline stocks', unit: 'mb', scale: 0.001, digits: 1 },
  distillate: { id: 'WDISTUS1', label: 'Distillate stocks', unit: 'mb', scale: 0.001, digits: 1 },
  utilization: { id: 'WPULEUS3', label: 'Refinery utilization', unit: '%', scale: 1, digits: 1 },
  production: { id: 'WCRFPUS2', label: 'Crude production', unit: 'kb/d', scale: 1, digits: 0 },
  imports: { id: 'WCRIMUS2', label: 'Crude imports', unit: 'kb/d', scale: 1, digits: 0 },
  exports: { id: 'WCREXUS2', label: 'Crude exports', unit: 'kb/d', scale: 1, digits: 0 },
  supplied: { id: 'WRPUPUS2', label: 'Total products supplied', unit: 'kb/d', scale: 1, digits: 0 },
} as const;

export type WeeklyKey = keyof typeof WEEKLY;

export function weeklyPetroleum(ctx: Ctx): Promise<EiaRow[]> {
  const now = ctx.now();
  return eiaData(ctx, 'petroleum/sum/sndw', {
    frequency: 'weekly',
    facets: { series: Object.values(WEEKLY).map((s) => s.id) },
    start: `${now.getUTCFullYear() - 6}-01-01`,
  });
}

/** Weekly working gas in underground storage, natural-gas/stor/wkly. */
export const STORAGE = {
  lower48: { id: 'NW2_EPG0_SWO_R48_BCF', label: 'Lower 48' },
  east: { id: 'NW2_EPG0_SWO_R31_BCF', label: 'East' },
  midwest: { id: 'NW2_EPG0_SWO_R32_BCF', label: 'Midwest' },
  southCentral: { id: 'NW2_EPG0_SWO_R33_BCF', label: 'South Central' },
  mountain: { id: 'NW2_EPG0_SWO_R34_BCF', label: 'Mountain' },
  pacific: { id: 'NW2_EPG0_SWO_R35_BCF', label: 'Pacific' },
} as const;

export type StorageKey = keyof typeof STORAGE;

export function gasStorage(ctx: Ctx): Promise<EiaRow[]> {
  const now = ctx.now();
  return eiaData(ctx, 'natural-gas/stor/wkly', {
    frequency: 'weekly',
    facets: { series: Object.values(STORAGE).map((s) => s.id) },
    start: `${now.getUTCFullYear() - 6}-01-01`,
  });
}
