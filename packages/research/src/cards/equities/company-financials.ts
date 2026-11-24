/** Company > Statements and the ratio cards built on them (ROIC, DuPont). */
import { pctChange } from '../../format.js';
import { NASDAQ, nasdaqGet, nasdaqSymbol } from '../../lib/nasdaq.js';
import { SourceError, type CardDef, type Column, type Ctx, type Format, type Row, type TableBlock } from '../../types.js';
import { parseValueTable, pct, rowOf, safeDiv, SYMBOL, symbolOf, type ValueTable } from './util.js';

export interface Financials {
  income: ValueTable;
  balance: ValueTable;
  cash: ValueTable;
  ratios: ValueTable;
}

interface RawFinancials {
  incomeStatementTable?: Parameters<typeof parseValueTable>[0];
  balanceSheetTable?: Parameters<typeof parseValueTable>[0];
  cashFlowTable?: Parameters<typeof parseValueTable>[0];
  financialRatiosTable?: Parameters<typeof parseValueTable>[0];
}

/** Nasdaq statement tables report thousands of dollars; values here are dollars. */
export async function financials(ctx: Ctx, symbol: string, quarterly = false): Promise<Financials> {
  const raw = await nasdaqGet<RawFinancials>(ctx, `/api/company/${encodeURIComponent(nasdaqSymbol(symbol))}/financials?frequency=${quarterly ? 2 : 1}`, 21_600);
  const f = {
    income: parseValueTable(raw.incomeStatementTable, 1000),
    balance: parseValueTable(raw.balanceSheetTable, 1000),
    cash: parseValueTable(raw.cashFlowTable, 1000),
    ratios: parseValueTable(raw.financialRatiosTable, 1),
  };
  if (!f.income.periods.length) throw new SourceError(NASDAQ, `no financial statements for ${symbol}`);
  return f;
}

export type View = 'reported' | 'common-size' | 'yoy';

/** Each value as a percent of the base row for the same period. */
export function commonSize(t: ValueTable, base: (number | null)[]): ValueTable {
  return { periods: t.periods, rows: t.rows.map((r) => ({ ...r, values: r.values.map((v, i) => pct(v, base[i])) })) };
}

/** Percent change of each period on the next older one (periods are newest first); the oldest has none. */
export function changeView(t: ValueTable): ValueTable {
  return { periods: t.periods, rows: t.rows.map((r) => ({ ...r, values: r.values.map((v, i) => pctChange(v, r.values[i + 1])) })) };
}

function statementBlock(t: ValueTable, format: Format, title: string): TableBlock {
  const columns: Column[] = [{ key: 'item', label: 'Line item', maxWidth: 46 }, ...t.periods.map((p, i) => ({ key: `p${i}`, label: p, format, digits: format === 'usdCompact' ? 2 : 1 }))];
  const rows: Row[] = t.rows
    .filter((r) => r.heading || r.values.some((v) => v !== null))
    .map((r) => {
      const row: Row = { item: r.heading ? `${r.label.toUpperCase()}` : r.label };
      r.values.forEach((v, i) => {
        row[`p${i}`] = v;
      });
      return row;
    });
  return { kind: 'table', title, columns, rows };
}

const PERIOD = { name: 'period', label: 'Period', default: 'annual', choices: ['annual', 'quarterly'] };
const VIEW = { name: 'view', label: 'View', default: 'reported', choices: ['reported', 'common-size', 'yoy'], hint: 'reported values, % of revenue or assets, or change on the prior period' };

function statementCard(id: string, title: string, pick: (f: Financials) => ValueTable, baseOf: (f: Financials) => { label: string; values: (number | null)[] }, page: string): CardDef {
  return {
    id,
    title,
    source: NASDAQ,
    description: `${title}, annual or quarterly, as reported, common size or as period-on-period change.`,
    params: [SYMBOL, PERIOD, VIEW],
    async run(ctx, params) {
      const symbol = symbolOf(params);
      const quarterly = params.period === 'quarterly';
      const view = (['reported', 'common-size', 'yoy'].includes(params.view) ? params.view : 'reported') as View;
      const f = await financials(ctx, symbol, quarterly);
      const t = pick(f);
      const base = baseOf(f);
      const shown = view === 'common-size' ? commonSize(t, base.values) : view === 'yoy' ? changeView(t) : t;
      const label = view === 'common-size' ? `% of ${base.label}` : view === 'yoy' ? (quarterly ? 'change on the prior quarter' : 'change on the prior year') : 'USD';
      const notes = ['Standardised line items from Nasdaq (source filings: SEC 10-K and 10-Q). Four periods are available.'];
      if (view === 'yoy' && quarterly) notes.push('Quarterly change is sequential (quarter on quarter), not year on year: only four quarters are published.');
      if (view === 'yoy') notes.push('The oldest period has no comparison and is blank.');
      return {
        blocks: [statementBlock(shown, view === 'reported' ? 'usdCompact' : view === 'yoy' ? 'signedPct' : 'pct', `${symbol} ${title.toLowerCase()} (${quarterly ? 'quarterly' : 'annual'}, ${label})`)],
        sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${nasdaqSymbol(symbol).toLowerCase()}/financials${page}`,
        asOf: t.periods[0],
        notes,
      };
    },
  };
}

const revenue = (f: Financials): { label: string; values: (number | null)[] } => ({ label: 'total revenue', values: rowOf(f.income, 'Total Revenue') });

const income = statementCard('equities.income-statement', 'Income statement', (f) => f.income, revenue, '');
const balance = statementCard('equities.balance-sheet', 'Balance sheet', (f) => f.balance, (f) => ({ label: 'total assets', values: rowOf(f.balance, 'Total Assets') }), '');
const cashFlow = statementCard('equities.cash-flow', 'Cash flow statement', (f) => f.cash, revenue, '');

// ---------------------------------------------------------------- ROIC and DuPont

const DEBT_ST = /^Short-Term Debt/i;

export interface RoicRow {
  period: string;
  nopat: number | null;
  taxRate: number | null;
  invested: number | null;
  roic: number | null;
}

/**
 * ROIC = NOPAT / invested capital. NOPAT = operating income x (1 - effective
 * tax rate); invested capital = equity + debt - cash and short-term
 * investments, averaged with the prior year when there is one.
 */
export function roicRows(f: Financials): RoicRow[] {
  const op = rowOf(f.income, 'Operating Income');
  const tax = rowOf(f.income, 'Income Tax');
  const ebt = rowOf(f.income, 'Earnings Before Tax');
  const eq = rowOf(f.balance, 'Total Equity');
  const std = rowOf(f.balance, DEBT_ST);
  const ltd = rowOf(f.balance, 'Long-Term Debt');
  const cash = rowOf(f.balance, 'Cash and Cash Equivalents');
  const sti = rowOf(f.balance, 'Short-Term Investments');
  const invested = f.income.periods.map((_, i) => (eq[i] === null ? null : eq[i]! + (std[i] ?? 0) + (ltd[i] ?? 0) - (cash[i] ?? 0) - (sti[i] ?? 0)));
  return f.income.periods.map((period, i) => {
    const rate = ebt[i] !== null && ebt[i]! > 0 && tax[i] !== null ? Math.min(0.6, Math.max(0, tax[i]! / ebt[i]!)) : null;
    const nopat = op[i] !== null && rate !== null ? op[i]! * (1 - rate) : null;
    const prior = invested[i + 1];
    const cap = invested[i] === null ? null : prior != null ? (invested[i]! + prior) / 2 : invested[i];
    return { period, nopat, taxRate: rate === null ? null : rate * 100, invested: cap, roic: cap !== null && cap > 0 ? pct(nopat, cap) : null };
  });
}

export interface DupontRow {
  period: string;
  margin: number | null;
  turnover: number | null;
  leverage: number | null;
  roe: number | null;
}

/** ROE = net margin x asset turnover x equity multiplier, on year-end balances. */
export function dupontRows(f: Financials): DupontRow[] {
  const ni = rowOf(f.income, 'Net Income');
  const rev = rowOf(f.income, 'Total Revenue');
  const assets = rowOf(f.balance, 'Total Assets');
  const eq = rowOf(f.balance, 'Total Equity');
  return f.income.periods.map((period, i) => {
    const margin = pct(ni[i], rev[i]);
    const turnover = safeDiv(rev[i], assets[i]);
    const leverage = eq[i] !== null && eq[i]! > 0 ? safeDiv(assets[i], eq[i]) : null;
    const roe = margin !== null && turnover !== null && leverage !== null ? margin * turnover * leverage : null;
    return { period, margin, turnover, leverage, roe };
  });
}

const roic: CardDef = {
  id: 'equities.roic',
  title: 'Return on invested capital',
  source: NASDAQ,
  description: 'After-tax operating profit over the capital invested in the business, for the last four fiscal years.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const f = await financials(ctx, symbol);
    // Banks and insurers report an unclassified balance sheet; deposits and float are not "invested capital", so ROIC would mislead.
    if (rowOf(f.balance, 'Total Current Assets').every((v) => v === null)) throw new SourceError(NASDAQ, `ROIC is not meaningful for ${symbol}: a bank, insurer or other financial with an unclassified balance sheet. Use the DuPont card (ROE) instead`);
    const rows = roicRows(f);
    if (!rows.some((r) => r.roic !== null)) throw new SourceError(NASDAQ, `ROIC cannot be computed for ${symbol} (no operating income, or invested capital is not positive; common for banks and insurers)`);
    const asc = [...rows].reverse();
    return {
      blocks: [
        { kind: 'chart', title: `${symbol} ROIC`, xType: 'category', style: 'bar', categories: asc.map((r) => r.period.slice(0, 4)), series: [{ name: 'ROIC %', points: asc.map((r, i) => [i, r.roic ?? 0]) }], yFormat: 'pct' },
        {
          kind: 'table',
          columns: [
            { key: 'period', label: 'Fiscal year end' },
            { key: 'roic', label: 'ROIC', format: 'pct' },
            { key: 'nopat', label: 'NOPAT', format: 'usdCompact' },
            { key: 'taxRate', label: 'Tax rate', format: 'pct', digits: 1 },
            { key: 'invested', label: 'Invested capital', format: 'usdCompact' },
          ],
          rows: rows.map((r) => ({ ...r })),
        },
      ],
      asOf: rows[0].period,
      notes: [
        'NOPAT = operating income x (1 - effective tax rate). Invested capital = equity + short- and long-term debt - cash and short-term investments, averaged with the prior year end (the oldest year uses its own year end).',
        'Operating leases and goodwill adjustments are not made.',
      ],
    };
  },
};

const dupont: CardDef = {
  id: 'equities.dupont',
  title: 'DuPont breakdown of ROE',
  source: NASDAQ,
  description: 'Return on equity split into net margin, asset turnover and financial leverage, for the last four fiscal years.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const rows = dupontRows(await financials(ctx, symbol));
    if (!rows.some((r) => r.roe !== null)) throw new SourceError(NASDAQ, `ROE cannot be decomposed for ${symbol} (equity is not positive or figures are missing)`);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'period', label: 'Fiscal year end' },
            { key: 'margin', label: 'Net margin', format: 'pct' },
            { key: 'turnover', label: 'Asset turnover', format: 'num', digits: 2 },
            { key: 'leverage', label: 'Equity multiplier', format: 'num', digits: 2 },
            { key: 'roe', label: 'ROE', format: 'pct' },
          ],
          rows: rows.map((r) => ({ ...r })),
          footnote: 'ROE = net margin x asset turnover x equity multiplier',
        },
      ],
      asOf: rows[0].period,
      notes: ['Year-end assets and equity (not averages), so ROE here is slightly lower than an average-equity ROE for a growing company. A row is blank when equity is negative.'],
    };
  },
};

export const financialCards: CardDef[] = [income, balance, cashFlow, roic, dupont];
