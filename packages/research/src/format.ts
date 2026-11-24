/** Value formatting shared by every renderer. */
import type { Cell, Format } from './types.js';

const NUMERIC: ReadonlySet<Format> = new Set([
  'num', 'int', 'compact', 'usd', 'usdCompact', 'pct', 'signed', 'signedPct', 'bp',
]);

export function isNumeric(format: Format | undefined): boolean {
  return format !== undefined && NUMERIC.has(format);
}

/** Formats whose sign carries meaning and gets coloured. */
export function isSigned(format: Format | undefined): boolean {
  return format === 'signed' || format === 'signedPct' || format === 'bp';
}

function group(n: number, digits: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function compact(n: number, digits = 2): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(digits)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(digits)}K`;
  return n.toFixed(a >= 100 || Number.isInteger(n) ? 0 : digits);
}

export function isoDate(v: number | string | Date): string {
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    const t = Date.parse(v);
    return Number.isNaN(t) ? v : new Date(t).toISOString().slice(0, 10);
  }
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Sensible decimals for a price-like number when the column does not say. */
function autoDigits(n: number): number {
  const a = Math.abs(n);
  if (a === 0) return 2;
  if (a < 0.01) return 6;
  if (a < 1) return 4;
  return 2;
}

export function formatValue(v: Cell, format: Format = 'text', digits?: number): string {
  if (v === null || v === undefined || v === '') return '';
  if (format === 'date') return isoDate(v as number | string);
  if (format === 'datetime') {
    if (typeof v === 'string' && Number.isNaN(Date.parse(v))) return v;
    const d = new Date(v as number | string);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace('T', ' ');
  }
  if (format === 'text' || typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return '';
  switch (format) {
    case 'int':
      return group(Math.round(v), 0);
    case 'compact':
      return compact(v, digits ?? 2);
    case 'usd':
      return `${v < 0 ? '-' : ''}$${group(Math.abs(v), digits ?? autoDigits(v))}`;
    case 'usdCompact':
      return `${v < 0 ? '-' : ''}$${compact(Math.abs(v), digits ?? 2)}`;
    case 'pct':
      return `${group(v, digits ?? 2)}%`;
    case 'signed':
      return `${v > 0 ? '+' : ''}${group(v, digits ?? autoDigits(v))}`;
    case 'signedPct':
      return `${v > 0 ? '+' : ''}${group(v, digits ?? 2)}%`;
    case 'bp':
      return `${v > 0 ? '+' : ''}${group(v, digits ?? 0)} bp`;
    default:
      return group(v, digits ?? autoDigits(v));
  }
}

/** -1, 0 or 1 for colouring; 0 for non-numbers. */
export function signOf(v: Cell): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.sign(v) : 0;
}

/** Percent change from `from` to `to`, or null when it cannot be computed. */
export function pctChange(to: number | null | undefined, from: number | null | undefined): number | null {
  if (to == null || from == null || !Number.isFinite(to) || !Number.isFinite(from) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}
