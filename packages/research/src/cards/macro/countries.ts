/** Country codes used across the macro cards. Reference data only (names and codes), no figures. */

export interface Economy {
  /** ISO-2, the shared `country` param. The euro area uses XM. */
  iso2: string;
  /** ISO-3 (IMF and OECD country code). */
  iso3: string;
  name: string;
  /** IMF DataMapper code (ISO-3, or a group code). */
  imf: string;
  /** BIS reference area that sets this economy's policy rate. */
  bis: string;
  /** OECD reference area. */
  oecd: string;
}

/** The economies on the Country Monitor, largest first within each bloc. */
export const MONITOR: Economy[] = [
  { iso2: 'US', iso3: 'USA', name: 'United States', imf: 'USA', bis: 'US', oecd: 'USA' },
  { iso2: 'XM', iso3: 'EMU', name: 'Euro area', imf: 'EURO', bis: 'XM', oecd: 'EA20' },
  { iso2: 'DE', iso3: 'DEU', name: 'Germany', imf: 'DEU', bis: 'XM', oecd: 'DEU' },
  { iso2: 'FR', iso3: 'FRA', name: 'France', imf: 'FRA', bis: 'XM', oecd: 'FRA' },
  { iso2: 'IT', iso3: 'ITA', name: 'Italy', imf: 'ITA', bis: 'XM', oecd: 'ITA' },
  { iso2: 'ES', iso3: 'ESP', name: 'Spain', imf: 'ESP', bis: 'XM', oecd: 'ESP' },
  { iso2: 'GB', iso3: 'GBR', name: 'United Kingdom', imf: 'GBR', bis: 'GB', oecd: 'GBR' },
  { iso2: 'JP', iso3: 'JPN', name: 'Japan', imf: 'JPN', bis: 'JP', oecd: 'JPN' },
  { iso2: 'CN', iso3: 'CHN', name: 'China', imf: 'CHN', bis: 'CN', oecd: 'CHN' },
  { iso2: 'IN', iso3: 'IND', name: 'India', imf: 'IND', bis: 'IN', oecd: 'IND' },
  { iso2: 'CA', iso3: 'CAN', name: 'Canada', imf: 'CAN', bis: 'CA', oecd: 'CAN' },
  { iso2: 'AU', iso3: 'AUS', name: 'Australia', imf: 'AUS', bis: 'AU', oecd: 'AUS' },
  { iso2: 'BR', iso3: 'BRA', name: 'Brazil', imf: 'BRA', bis: 'BR', oecd: 'BRA' },
  { iso2: 'MX', iso3: 'MEX', name: 'Mexico', imf: 'MEX', bis: 'MX', oecd: 'MEX' },
  { iso2: 'KR', iso3: 'KOR', name: 'South Korea', imf: 'KOR', bis: 'KR', oecd: 'KOR' },
  { iso2: 'CH', iso3: 'CHE', name: 'Switzerland', imf: 'CHE', bis: 'CH', oecd: 'CHE' },
  { iso2: 'SE', iso3: 'SWE', name: 'Sweden', imf: 'SWE', bis: 'SE', oecd: 'SWE' },
];

/** ISO-2 -> [ISO-3, name]. Euro-area members carry `euro: true` in EURO_MEMBERS below. */
const TABLE: Record<string, [string, string]> = {
  AE: ['ARE', 'United Arab Emirates'], AR: ['ARG', 'Argentina'], AT: ['AUT', 'Austria'], AU: ['AUS', 'Australia'],
  BD: ['BGD', 'Bangladesh'], BE: ['BEL', 'Belgium'], BG: ['BGR', 'Bulgaria'], BR: ['BRA', 'Brazil'], CA: ['CAN', 'Canada'],
  CH: ['CHE', 'Switzerland'], CL: ['CHL', 'Chile'], CN: ['CHN', 'China'], CO: ['COL', 'Colombia'], CR: ['CRI', 'Costa Rica'],
  CY: ['CYP', 'Cyprus'], CZ: ['CZE', 'Czechia'], DE: ['DEU', 'Germany'], DK: ['DNK', 'Denmark'], EE: ['EST', 'Estonia'],
  EG: ['EGY', 'Egypt'], ES: ['ESP', 'Spain'], FI: ['FIN', 'Finland'], FR: ['FRA', 'France'], GB: ['GBR', 'United Kingdom'],
  GR: ['GRC', 'Greece'], HK: ['HKG', 'Hong Kong SAR'], HR: ['HRV', 'Croatia'], HU: ['HUN', 'Hungary'], ID: ['IDN', 'Indonesia'],
  IE: ['IRL', 'Ireland'], IL: ['ISR', 'Israel'], IN: ['IND', 'India'], IS: ['ISL', 'Iceland'], IT: ['ITA', 'Italy'],
  JP: ['JPN', 'Japan'], KR: ['KOR', 'South Korea'], KZ: ['KAZ', 'Kazakhstan'], LT: ['LTU', 'Lithuania'], LU: ['LUX', 'Luxembourg'],
  LV: ['LVA', 'Latvia'], MA: ['MAR', 'Morocco'], MT: ['MLT', 'Malta'], MX: ['MEX', 'Mexico'], MY: ['MYS', 'Malaysia'],
  NG: ['NGA', 'Nigeria'], NL: ['NLD', 'Netherlands'], NO: ['NOR', 'Norway'], NZ: ['NZL', 'New Zealand'], PE: ['PER', 'Peru'],
  PH: ['PHL', 'Philippines'], PK: ['PAK', 'Pakistan'], PL: ['POL', 'Poland'], PT: ['PRT', 'Portugal'], QA: ['QAT', 'Qatar'],
  RO: ['ROU', 'Romania'], RS: ['SRB', 'Serbia'], RU: ['RUS', 'Russia'], SA: ['SAU', 'Saudi Arabia'], SE: ['SWE', 'Sweden'],
  SG: ['SGP', 'Singapore'], SI: ['SVN', 'Slovenia'], SK: ['SVK', 'Slovakia'], TH: ['THA', 'Thailand'], TR: ['TUR', 'Turkiye'],
  TW: ['TWN', 'Taiwan'], UA: ['UKR', 'Ukraine'], US: ['USA', 'United States'], VN: ['VNM', 'Vietnam'], ZA: ['ZAF', 'South Africa'],
};

const EURO_MEMBERS = new Set(['AT', 'BE', 'BG', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']);

/** Names for the aggregate codes sources use alongside countries. */
const AGGREGATES: Record<string, string> = {
  EA20: 'Euro area', EA: 'Euro area', EA19: 'Euro area (19)', EU27: 'European Union', EU27_2020: 'European Union', OECD: 'OECD total', OECDE: 'OECD Europe', G7: 'G7', G20: 'G20',
  G4E: 'Major four Europe', NAFTA: 'North America', A5M: 'Major five Asia', EURO: 'Euro area', EU: 'European Union', WEOWORLD: 'World',
  ADVEC: 'Advanced economies', OEMDC: 'Emerging and developing economies', XM: 'Euro area', EMU: 'Euro area',
};

const BY_ISO3: Record<string, string> = Object.fromEntries(Object.entries(TABLE).map(([iso2, [iso3]]) => [iso3, iso2]));

/** Display name for an ISO-3 or aggregate code; the code itself when unknown. */
export function nameOf(code: string): string {
  const c = code.toUpperCase();
  if (AGGREGATES[c]) return AGGREGATES[c];
  const iso2 = BY_ISO3[c] ?? (TABLE[c] ? c : undefined);
  return iso2 ? TABLE[iso2][1] : code;
}

/**
 * Resolve the shared `country` param: ISO-2, ISO-3, or the euro area as
 * XM / EA / EZ / EMU. Unknown three-letter codes pass through as ISO-3 so
 * any IMF or OECD member can be requested.
 */
export function resolveEconomy(input: string | undefined): Economy {
  const c = (input ?? 'US').trim().toUpperCase() || 'US';
  if (['XM', 'EA', 'EZ', 'EMU', 'EURO', 'EA20', 'U2'].includes(c)) return MONITOR[1];
  const listed = MONITOR.find((m) => m.iso2 === c || m.iso3 === c);
  if (listed) return listed;
  const iso2 = TABLE[c] ? c : BY_ISO3[c];
  if (iso2) {
    const [iso3, name] = TABLE[iso2];
    return { iso2, iso3, name, imf: iso3, bis: EURO_MEMBERS.has(iso2) ? 'XM' : iso2, oecd: iso3 };
  }
  if (/^[A-Z]{3}$/.test(c)) return { iso2: c, iso3: c, name: c, imf: c, bis: c, oecd: c };
  if (/^[A-Z]{2}$/.test(c)) return { iso2: c, iso3: c, name: c, imf: c, bis: c, oecd: c };
  throw new Error(`country: expected an ISO-2 code such as US, DE or JP, got "${input}"`);
}

/** Country name -> ISO-2 for search ("germany" -> DE). */
export function findCountries(query: string): { iso2: string; name: string }[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: { iso2: string; name: string }[] = [];
  if ('euro area'.includes(q) || q === 'eurozone' || q === 'euro zone') out.push({ iso2: 'XM', name: 'Euro area' });
  for (const [iso2, [iso3, name]] of Object.entries(TABLE)) {
    const n = name.toLowerCase();
    if (n === q || iso2.toLowerCase() === q || iso3.toLowerCase() === q || (q.length >= 3 && n.startsWith(q))) out.push({ iso2, name });
  }
  if (q === 'uk' || q === 'britain') out.push({ iso2: 'GB', name: 'United Kingdom' });
  if (q === 'usa' || q === 'america') out.push({ iso2: 'US', name: 'United States' });
  if (q === 'korea') out.push({ iso2: 'KR', name: 'South Korea' });
  if (q === 'turkey') out.push({ iso2: 'TR', name: 'Turkiye' });
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.iso2) ? false : (seen.add(c.iso2), true)));
}
