/**
 * IMF data API (SDMX 2.1, CSV): the Primary Commodity Price System (PCPS),
 * International Liquidity (reserves) and COFER (currency composition of
 * reserves). No key. Rows are wide (each carries the dataset description),
 * so requests name the exact series and a start period.
 */
import { csvObjects, num } from '../../http.js';
import { SourceError, type Ctx } from '../../types.js';
import { periodMs, type Point } from './util.js';

export const IMF = 'IMF';
const BASE = 'https://api.imf.org/external/sdmx/2.1/data';

export type ImfRow = Record<string, string>;

/** Data rows of an IMF SDMX-CSV response (the first row is dataset metadata with no period). */
export function parseImfCsv(text: string): ImfRow[] {
  return csvObjects(text).filter((r) => r.TIME_PERIOD && r.OBS_VALUE !== undefined && r.OBS_VALUE !== '');
}

/**
 * `flow` is "AGENCY,DATAFLOW" (e.g. "IMF.RES,PCPS"); `key` is the
 * dot-separated series key with `+` between alternatives and an empty
 * position for "all".
 */
export async function imfData(ctx: Ctx, flow: string, key: string, startPeriod: string, ttl = 21_600): Promise<ImfRow[]> {
  const url = `${BASE}/${flow}/${key}?startPeriod=${encodeURIComponent(startPeriod)}`;
  const text = await ctx.http.text(url, {
    source: IMF,
    ttl,
    timeoutMs: 60_000,
    headers: { accept: 'application/vnd.sdmx.data+csv;version=1.0.0' },
  });
  const rows = parseImfCsv(text);
  if (!rows.length) throw new SourceError(IMF, `no observations for ${flow.split(',')[1] ?? flow} ${key}`);
  return rows;
}

/** Points (oldest first) of the rows matching every column in `match`. */
export function imfPoints(rows: ImfRow[], match: Record<string, string>): Point[] {
  const out: Point[] = [];
  for (const r of rows) {
    let ok = true;
    for (const [k, v] of Object.entries(match)) {
      if (r[k] !== v) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const t = periodMs(r.TIME_PERIOD);
    const v = num(r.OBS_VALUE);
    if (!Number.isNaN(t) && v !== null) out.push([t, v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------- PCPS

export const PCPS_URL = 'https://data.imf.org/en/datasets/IMF.RES:PCPS';

export interface PcpsItem {
  code: string;
  name: string;
  unit: string;
}

/** Benchmark prices in the PCPS, with the unit each is quoted in. */
export const PCPS: Record<string, PcpsItem> = Object.fromEntries(
  (
    [
      ['POILWTI', 'Crude oil, WTI', 'USD/bbl'],
      ['POILBRE', 'Crude oil, Brent', 'USD/bbl'],
      ['POILDUB', 'Crude oil, Dubai', 'USD/bbl'],
      ['PNGASUS', 'Natural gas, Henry Hub', 'USD/MMBtu'],
      ['PNGASEU', 'Natural gas, Europe (TTF)', 'USD/MMBtu'],
      ['PNGASJP', 'LNG, Japan / Korea', 'USD/MMBtu'],
      ['PCOALAU', 'Coal, Australia', 'USD/mt'],
      ['PCOALSA', 'Coal, South Africa', 'USD/mt'],
      ['PPROPANE', 'Propane', 'USD/gal'],
      ['PURAN', 'Uranium (U3O8)', 'USD/lb'],
      ['PGOLD', 'Gold', 'USD/oz'],
      ['PSILVER', 'Silver', 'USD/oz'],
      ['PPLAT', 'Platinum', 'USD/oz'],
      ['PPALLA', 'Palladium', 'USD/oz'],
      ['PCOPP', 'Copper', 'USD/mt'],
      ['PALUM', 'Aluminum', 'USD/mt'],
      ['PNICK', 'Nickel', 'USD/mt'],
      ['PZINC', 'Zinc', 'USD/mt'],
      ['PLEAD', 'Lead', 'USD/mt'],
      ['PTIN', 'Tin', 'USD/mt'],
      ['PIORECR', 'Iron ore', 'USD/mt'],
      ['PCOBA', 'Cobalt', 'USD/mt'],
      ['PMAIZMT', 'Corn (maize)', 'USD/mt'],
      ['PWHEAMT', 'Wheat', 'USD/mt'],
      ['PSOYB', 'Soybeans', 'USD/mt'],
      ['PRICENPQ', 'Rice, Thailand', 'USD/mt'],
      ['PBARL', 'Barley', 'USD/mt'],
      ['PSMEA', 'Soybean meal', 'USD/mt'],
      ['PSOIL', 'Soybean oil', 'USD/mt'],
      ['PPOIL', 'Palm oil', 'USD/mt'],
      ['PSUNO', 'Sunflower oil', 'USD/mt'],
      ['PSUGAISA', 'Sugar, world', 'US cents/lb'],
      ['PSUGAUSA', 'Sugar, U.S.', 'US cents/lb'],
      ['PCOFFOTM', 'Coffee, arabica', 'US cents/lb'],
      ['PCOFFROB', 'Coffee, robusta', 'US cents/lb'],
      ['PCOCO', 'Cocoa', 'USD/mt'],
      ['PCOTTIND', 'Cotton', 'US cents/lb'],
      ['PORANG', 'Orange juice', 'USD/lb'],
      ['PRUBB', 'Rubber', 'US cents/lb'],
      ['PBEEF', 'Beef', 'US cents/lb'],
      ['PPORK', 'Pork (lean hogs)', 'US cents/lb'],
      ['PPOULT', 'Poultry', 'US cents/lb'],
      ['PLAMB', 'Lamb', 'US cents/lb'],
      ['PUREA', 'Urea', 'USD/mt'],
      ['PDAP', 'DAP fertilizer', 'USD/mt'],
      ['PPOTASH', 'Potash', 'USD/mt'],
    ] as const
  ).map(([code, name, unit]) => [code, { code, name, unit }]),
);

/** Monthly average prices in U.S. dollars for the given PCPS codes: one request. */
export async function pcpsSeries(ctx: Ctx, codes: string[], startMonth: string): Promise<Map<string, Point[]>> {
  const rows = await imfData(ctx, 'IMF.RES,PCPS', `G001.${codes.join('+')}.USD.M`, startMonth);
  const out = new Map<string, Point[]>();
  for (const code of codes) {
    const pts = imfPoints(rows, { INDICATOR: code, FREQUENCY: 'M' });
    if (pts.length) out.set(code, pts);
  }
  if (!out.size) throw new SourceError(IMF, 'no commodity prices returned');
  return out;
}
