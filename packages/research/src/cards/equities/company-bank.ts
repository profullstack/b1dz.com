/** Company > Bank: asset quality of a U.S. bank holding company's lead bank, from FDIC call reports. */
import { cikFor, submissions } from '../../lib/sec.js';
import { SourceError, type CardDef, type Row, type StatItem } from '../../types.js';
import { symbolOf } from './util.js';

const FDIC = 'FDIC';

interface Institution {
  NAME?: string;
  CERT?: number;
  ASSET?: number;
  NAMEHCR?: string;
  CITY?: string;
  STALP?: string;
}
interface FdicBody<T> {
  data?: { data?: T }[];
}

/** Holding-company names differ in spacing and legal suffixes between the SEC and the FDIC ("JPMORGAN CHASE & CO" vs "JPMORGAN CHASE&CO"). */
export function holdingKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/\/[A-Z]{2,3}\/?\s*$/, '')
    .replace(/[^A-Z0-9 &]/g, ' ')
    .replace(/&/g, ' & ')
    .split(/\s+/)
    .filter((w) => w && !['&', 'CO', 'CORP', 'CORPORATION', 'INC', 'COMPANY', 'THE', 'LTD', 'NEW', 'DE'].includes(w))
    .join('');
}

/** The largest active bank whose holding company matches; null when none does. */
export function pickBank(list: Institution[], company: string): Institution | null {
  const want = holdingKey(company);
  if (!want) return null;
  const hits = list.filter((i) => {
    const have = holdingKey(i.NAMEHCR ?? '');
    // Prefix matches only for names long enough not to collide ("US" must match exactly).
    return have !== '' && (have === want || (Math.min(have.length, want.length) >= 6 && (have.startsWith(want) || want.startsWith(have))));
  });
  return hits.sort((a, b) => (b.ASSET ?? 0) - (a.ASSET ?? 0))[0] ?? null;
}

const FIELDS = ['REPDTE', 'ASSET', 'DEP', 'LNLSNET', 'NCLNLSR', 'NTLNLSR', 'LNATRESR', 'P3ASSET', 'P9ASSET', 'NAASSET', 'ROA', 'ROE', 'NIMY', 'EEFFR', 'RBCT1CER', 'RBC1AAJ', 'LNLSDEPR'];

const bankQuality: CardDef = {
  id: 'equities.bank-quality',
  title: 'Bank asset quality (FDIC)',
  source: FDIC,
  description: "For a U.S. bank holding company: its lead bank's noncurrent loans, net charge-offs, loss reserves, past-due assets, capital and profitability from quarterly call reports.",
  params: [{ name: 'symbol', label: 'Symbol', default: 'JPM', hint: 'ticker of a U.S. bank holding company, e.g. JPM, BAC, WFC, USB' }],
  async run(ctx, params) {
    const symbol = symbolOf(params, 'JPM');
    const reg = await cikFor(ctx, symbol);
    // Only financial registrants (SIC 60-62 banks, credit and brokers; 67 holding companies) can own an insured bank worth showing.
    const sic = (await submissions(ctx, reg.cik)).sic ?? '';
    if (!/^6[0127]/.test(sic)) throw new SourceError(FDIC, `${symbol} (${reg.title}) is not a bank holding company (SIC ${sic || 'unknown'})`);
    // Search the holding-company name one word at a time (longest-lived word first), largest banks first, then match the whole name.
    const words = reg.title.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter((w) => w.length >= 3 && !/^(the|inc|corp|co|new)$/i.test(w)).slice(0, 2);
    let bank: Institution | null = null;
    for (const word of words) {
      const found = await ctx.http.json<FdicBody<Institution>>(
        `https://banks.data.fdic.gov/api/institutions?search=${encodeURIComponent(`NAMEHCR:${word}`)}&filters=${encodeURIComponent('ACTIVE:1')}&sort_by=ASSET&sort_order=DESC&limit=50&fields=NAME,CERT,ASSET,NAMEHCR,CITY,STALP`,
        { source: FDIC, ttl: 86_400 },
      );
      bank = pickBank((found.data ?? []).flatMap((d) => (d.data ? [d.data] : [])), reg.title);
      if (bank) break;
    }
    if (!bank?.CERT) throw new SourceError(FDIC, `${symbol} (${reg.title}) is not the holding company of an FDIC-insured bank`);
    const fin = await ctx.http.json<FdicBody<Record<string, number | string>>>(
      `https://banks.data.fdic.gov/api/financials?filters=${encodeURIComponent(`CERT:${bank.CERT}`)}&fields=${FIELDS.join(',')}&sort_by=REPDTE&sort_order=DESC&limit=40`,
      { source: FDIC, ttl: 21_600 },
    );
    const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const k = (v: unknown): number | null => (n(v) === null ? null : n(v)! * 1000);
    const rows = (fin.data ?? []).flatMap((d) => {
      const r = d.data;
      const rep = String(r?.REPDTE ?? '');
      if (!r || !/^\d{8}$/.test(rep)) return [];
      return [{
        date: `${rep.slice(0, 4)}-${rep.slice(4, 6)}-${rep.slice(6, 8)}`,
        assets: k(r.ASSET),
        loans: k(r.LNLSNET),
        deposits: k(r.DEP),
        noncurrent: n(r.NCLNLSR),
        chargeoffs: n(r.NTLNLSR),
        reserve: n(r.LNATRESR),
        pastDue30: k(r.P3ASSET),
        pastDue90: k(r.P9ASSET),
        nonaccrual: k(r.NAASSET),
        roa: n(r.ROA),
        roe: n(r.ROE),
        nim: n(r.NIMY),
        efficiency: n(r.EEFFR),
        cet1: n(r.RBCT1CER),
        leverage: n(r.RBC1AAJ),
        loanDeposit: n(r.LNLSDEPR),
      }];
    });
    if (!rows.length) throw new SourceError(FDIC, `no call-report data for ${bank.NAME}`);
    const last = rows[0];
    const items: StatItem[] = [
      { label: 'Total assets', value: last.assets, format: 'usdCompact' },
      { label: 'Net loans', value: last.loans, format: 'usdCompact' },
      { label: 'Deposits', value: last.deposits, format: 'usdCompact' },
      { label: 'Noncurrent loans / loans', value: last.noncurrent, format: 'pct' },
      { label: 'Net charge-offs / loans', value: last.chargeoffs, format: 'pct' },
      { label: 'Loss reserve / loans', value: last.reserve, format: 'pct' },
      { label: 'Nonaccrual assets', value: last.nonaccrual, format: 'usdCompact' },
      { label: 'Past due 30-89 days', value: last.pastDue30, format: 'usdCompact' },
      { label: 'Past due 90+ days', value: last.pastDue90, format: 'usdCompact' },
      { label: 'CET1 ratio', value: last.cet1, format: 'pct' },
      { label: 'Leverage ratio', value: last.leverage, format: 'pct' },
      { label: 'Loans / deposits', value: last.loanDeposit, format: 'pct', digits: 1 },
      { label: 'Net interest margin', value: last.nim, format: 'pct' },
      { label: 'Efficiency ratio', value: last.efficiency, format: 'pct', digits: 1 },
      { label: 'Return on assets', value: last.roa, format: 'pct' },
      { label: 'Return on equity', value: last.roe, format: 'pct' },
    ];
    const asc = [...rows].reverse();
    const line = (name: string, key: 'noncurrent' | 'chargeoffs' | 'reserve'): { name: string; points: [number, number][] } => ({ name, points: asc.filter((r) => r[key] !== null).map((r) => [Date.parse(`${r.date}T00:00:00Z`), r[key]!]) });
    const table: Row[] = rows.slice(0, 12).map((r) => ({ date: r.date, noncurrent: r.noncurrent, chargeoffs: r.chargeoffs, reserve: r.reserve, nonaccrual: r.nonaccrual, pastDue90: r.pastDue90, cet1: r.cet1, nim: r.nim, roe: r.roe }));
    return {
      blocks: [
        { kind: 'stats', title: `${bank.NAME} (FDIC certificate ${bank.CERT}), ${bank.CITY}, ${bank.STALP}`, items },
        { kind: 'chart', title: 'Asset quality, % of loans', xType: 'time', series: [line('Noncurrent loans', 'noncurrent'), line('Net charge-offs (annualised)', 'chargeoffs'), line('Loss reserve', 'reserve')], yFormat: 'pct' },
        {
          kind: 'table',
          title: 'Last twelve quarters',
          columns: [
            { key: 'date', label: 'Quarter end' },
            { key: 'noncurrent', label: 'Noncurrent', format: 'pct' },
            { key: 'chargeoffs', label: 'Net charge-offs', format: 'pct' },
            { key: 'reserve', label: 'Reserve', format: 'pct' },
            { key: 'nonaccrual', label: 'Nonaccrual', format: 'usdCompact' },
            { key: 'pastDue90', label: '90+ past due', format: 'usdCompact' },
            { key: 'cet1', label: 'CET1', format: 'pct' },
            { key: 'nim', label: 'NIM', format: 'pct' },
            { key: 'roe', label: 'ROE', format: 'pct' },
          ],
          rows: table,
        },
      ],
      sourceUrl: `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${bank.CERT}`,
      asOf: last.date,
      notes: [
        `Figures are for the insured bank subsidiary (${bank.NAME}), the largest bank under ${reg.title}, from its quarterly call report; the holding company's own consolidated numbers differ (broker-dealer and other non-bank units are outside the bank).`,
        'Ratios are year to date, annualised by the FDIC. Noncurrent = 90+ days past due plus nonaccrual.',
      ],
    };
  },
};

export const bankCards: CardDef[] = [bankQuality];
