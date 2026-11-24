import { describe, expect, it } from 'vitest';
import type { CompanyFacts } from '../../lib/sec.js';
import { annual, flows, fundamentals, latestAsOf, monthEnds, multiplesAt, pickFacts, quarterly, splitAdjust, splitRatio, stocks, ttmAsOf } from './xbrl.js';

const f = (start: string | undefined, end: string, val: number, filed: string): { start?: string; end: string; val: number; filed: string } => ({ start, end, val, filed });

const facts: CompanyFacts = {
  facts: {
    'us-gaap': {
      Revenues: { units: { USD: [f('2023-01-01', '2023-12-31', 400, '2024-02-01')] } },
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: {
          USD: [
            f('2024-01-01', '2024-03-31', 100, '2024-05-01'),
            f('2024-04-01', '2024-06-30', 110, '2024-08-01'),
            f('2024-01-01', '2024-06-30', 210, '2024-08-01'),
            f('2024-07-01', '2024-09-30', 120, '2024-11-01'),
            f('2024-01-01', '2024-12-31', 470, '2025-02-01'),
            // The first quarter restated a year later in the next 10-Q.
            f('2024-01-01', '2024-03-31', 101, '2025-05-01'),
            f('2025-01-01', '2025-03-31', 130, '2025-05-01'),
          ],
        },
      },
      NetIncomeLoss: {
        units: {
          USD: [
            f('2024-01-01', '2024-03-31', 10, '2024-05-01'),
            f('2024-04-01', '2024-06-30', 11, '2024-08-01'),
            f('2024-07-01', '2024-09-30', 12, '2024-11-01'),
            f('2024-01-01', '2024-12-31', 47, '2025-02-01'),
            f('2025-01-01', '2025-03-31', 13, '2025-05-01'),
          ],
        },
      },
      StockholdersEquity: { units: { USD: [f(undefined, '2024-12-31', 200, '2025-02-01'), f(undefined, '2025-03-31', 210, '2025-05-01')] } },
      WeightedAverageNumberOfDilutedSharesOutstanding: {
        units: {
          shares: [
            f('2024-07-01', '2024-09-30', 10, '2024-11-01'),
            // A 4-for-1 split takes effect before the next quarter is reported.
            f('2025-01-01', '2025-03-31', 40, '2025-05-01'),
          ],
        },
      },
    },
  },
};

describe('pickFacts', () => {
  it('keeps the first-filed or the latest value for a period', () => {
    const first = pickFacts(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax'], 'USD', 'first').find((x) => x.end === '2024-03-31');
    const last = pickFacts(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax'], 'USD', 'last').find((x) => x.end === '2024-03-31');
    expect(first?.val).toBe(100);
    expect(last?.val).toBe(101);
  });
  it('merges tags a company switched between', () => {
    const merged = pickFacts(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues']);
    expect(annual(flows(merged)).map((y) => y.val)).toEqual([400, 470]);
    expect(pickFacts(facts, ['NoSuchTag'])).toEqual([]);
  });
});

describe('quarters and trailing twelve months', () => {
  const q = quarterly(flows(pickFacts(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax'])));
  it('derives the fourth quarter from the year', () => {
    expect(q.map((x) => [x.end, x.val, Boolean(x.derived)])).toEqual([
      ['2024-03-31', 100, false],
      ['2024-06-30', 110, false],
      ['2024-09-30', 120, false],
      ['2024-12-31', 140, true],
      ['2025-03-31', 130, false],
    ]);
    expect(q[3].start).toBe('2024-10-01');
    expect(q[3].filed).toBe('2025-02-01');
  });
  it('sums the four quarters on file at a date', () => {
    expect(ttmAsOf(q, '2025-01-31')).toBeNull();
    expect(ttmAsOf(q, '2025-02-01')).toEqual({ val: 470, end: '2024-12-31' });
    expect(ttmAsOf(q, '2025-06-01')).toEqual({ val: 500, end: '2025-03-31' });
  });
  it('refuses a trailing sum with a missing quarter', () => {
    expect(ttmAsOf(q.filter((x) => x.end !== '2024-09-30'), '2025-06-01')).toBeNull();
  });
  it('finds the latest value on file', () => {
    const eq = stocks(pickFacts(facts, ['StockholdersEquity']));
    expect(latestAsOf(eq, '2025-03-01')?.val).toBe(200);
    expect(latestAsOf(eq, '2025-05-01')?.val).toBe(210);
    expect(latestAsOf(eq, '2024-01-01')).toBeNull();
  });
});

describe('split handling', () => {
  it('recognises split-sized jumps only', () => {
    expect(splitRatio(4.02)).toBe(4);
    expect(splitRatio(0.1)).toBeCloseTo(0.1);
    expect(splitRatio(1.3)).toBeNull();
    expect(splitRatio(2.6)).toBeNull();
    expect(splitRatio(NaN)).toBeNull();
  });
  it('restates earlier share counts to the current basis', () => {
    expect(splitAdjust([{ val: 100 }, { val: 101 }, { val: 404 }, { val: 400 }]).map((s) => s.val)).toEqual([400, 404, 404, 400]);
    expect(splitAdjust([{ val: 1000 }, { val: 100 }]).map((s) => s.val)).toEqual([100, 100]);
    expect(splitAdjust([])).toEqual([]);
  });
});

describe('multiples', () => {
  const fund = fundamentals(facts);
  it('adjusts shares for the split and uses only filed figures', () => {
    expect(fund.shares.map((s) => s.val)).toEqual([40, 40]);
    const t = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
    const m = multiplesAt(fund, [{ t: t('2025-01-15'), c: 5 }, { t: t('2025-02-15'), c: 5 }, { t: t('2025-06-15'), c: 6 }]);
    // Mid-January: the year is not filed yet, so there is no trailing figure.
    expect(m[0]).toMatchObject({ marketCap: 200, pe: null, ps: null, pb: null });
    expect(m[1].pe).toBeCloseTo(200 / 47);
    expect(m[1].ps).toBeCloseTo(200 / 470);
    expect(m[1].pb).toBeCloseTo(1);
    expect(m[2].marketCap).toBe(240);
    expect(m[2].pe).toBeCloseTo(240 / 50);
    expect(m[2].pb).toBeCloseTo(240 / 210);
  });
  it('picks the last bar of each month', () => {
    const d = (iso: string): { t: number } => ({ t: Date.parse(`${iso}T00:00:00Z`) });
    expect(monthEnds([d('2026-01-29'), d('2026-01-30'), d('2026-02-02'), d('2026-02-27'), d('2026-03-02')]).map((x) => new Date(x.t).toISOString().slice(0, 10))).toEqual(['2026-01-30', '2026-02-27', '2026-03-02']);
  });
});
