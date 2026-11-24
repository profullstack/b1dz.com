/**
 * Bank for International Settlements statistics API (SDMX, CSV). No key.
 * Used for central bank policy rates (WS_CBPOL) and effective exchange
 * rates (WS_EER).
 */
import { csvObjects, num } from '../../http.js';
import { SourceError, type Ctx } from '../../types.js';
import { periodMs, type Point } from './util.js';

export const BIS = 'BIS';
const BASE = 'https://stats.bis.org/api/v2/data/dataflow/BIS';

export type BisRow = Record<string, string>;

export function parseBisCsv(text: string): BisRow[] {
  return csvObjects(text).filter((r) => r.TIME_PERIOD && r.OBS_VALUE !== undefined && r.OBS_VALUE !== '' && r.OBS_VALUE !== 'NaN');
}

/** `query` is extra SDMX parameters, e.g. "startPeriod=2025-01" or "lastNObservations=1". */
export async function bisData(ctx: Ctx, flow: string, key: string, query: string, ttl = 21_600): Promise<BisRow[]> {
  const text = await ctx.http.text(`${BASE}/${flow}/1.0/${key}?${query}&format=csv`, { source: BIS, ttl, timeoutMs: 45_000 });
  const rows = parseBisCsv(text);
  if (!rows.length) throw new SourceError(BIS, `no observations for ${flow} ${key}`);
  return rows;
}

export function bisPoints(rows: BisRow[], match: Record<string, string>): Point[] {
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

export interface Area {
  /** BIS reference area (ISO-2, with XM for the euro area). */
  code: string;
  name: string;
  currency: string;
  /** ISO-3 code as the IMF uses it. */
  iso3?: string;
}

export const AREAS: Area[] = [
  { code: 'US', name: 'United States', currency: 'USD', iso3: 'USA' },
  { code: 'XM', name: 'Euro area', currency: 'EUR' },
  { code: 'JP', name: 'Japan', currency: 'JPY', iso3: 'JPN' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', iso3: 'GBR' },
  { code: 'CH', name: 'Switzerland', currency: 'CHF', iso3: 'CHE' },
  { code: 'CA', name: 'Canada', currency: 'CAD', iso3: 'CAN' },
  { code: 'AU', name: 'Australia', currency: 'AUD', iso3: 'AUS' },
  { code: 'NZ', name: 'New Zealand', currency: 'NZD', iso3: 'NZL' },
  { code: 'SE', name: 'Sweden', currency: 'SEK', iso3: 'SWE' },
  { code: 'NO', name: 'Norway', currency: 'NOK', iso3: 'NOR' },
  { code: 'DK', name: 'Denmark', currency: 'DKK', iso3: 'DNK' },
  { code: 'CN', name: 'China', currency: 'CNY', iso3: 'CHN' },
  { code: 'IN', name: 'India', currency: 'INR', iso3: 'IND' },
  { code: 'KR', name: 'South Korea', currency: 'KRW', iso3: 'KOR' },
  { code: 'ID', name: 'Indonesia', currency: 'IDR', iso3: 'IDN' },
  { code: 'MY', name: 'Malaysia', currency: 'MYR', iso3: 'MYS' },
  { code: 'PH', name: 'Philippines', currency: 'PHP', iso3: 'PHL' },
  { code: 'TH', name: 'Thailand', currency: 'THB', iso3: 'THA' },
  { code: 'HK', name: 'Hong Kong', currency: 'HKD', iso3: 'HKG' },
  { code: 'SG', name: 'Singapore', currency: 'SGD', iso3: 'SGP' },
  { code: 'BR', name: 'Brazil', currency: 'BRL', iso3: 'BRA' },
  { code: 'MX', name: 'Mexico', currency: 'MXN', iso3: 'MEX' },
  { code: 'CL', name: 'Chile', currency: 'CLP', iso3: 'CHL' },
  { code: 'CO', name: 'Colombia', currency: 'COP', iso3: 'COL' },
  { code: 'ZA', name: 'South Africa', currency: 'ZAR', iso3: 'ZAF' },
  { code: 'TR', name: 'Turkey', currency: 'TRY', iso3: 'TUR' },
  { code: 'IL', name: 'Israel', currency: 'ILS', iso3: 'ISR' },
  { code: 'SA', name: 'Saudi Arabia', currency: 'SAR', iso3: 'SAU' },
  { code: 'PL', name: 'Poland', currency: 'PLN', iso3: 'POL' },
  { code: 'CZ', name: 'Czechia', currency: 'CZK', iso3: 'CZE' },
  { code: 'HU', name: 'Hungary', currency: 'HUF', iso3: 'HUN' },
  { code: 'RO', name: 'Romania', currency: 'RON', iso3: 'ROU' },
  { code: 'RU', name: 'Russia', currency: 'RUB', iso3: 'RUS' },
];

export function areaByCurrency(currency: string): Area | undefined {
  return AREAS.find((a) => a.currency === currency.toUpperCase());
}

/** Accepts an ISO-2 country code; EU, EA and EZ all mean the euro area. */
export function areaByCountry(country: string): Area | undefined {
  const c = country.trim().toUpperCase();
  const code = c === 'EU' || c === 'EA' || c === 'EZ' ? 'XM' : c === 'UK' ? 'GB' : c;
  return AREAS.find((a) => a.code === code);
}
