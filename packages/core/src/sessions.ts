/**
 * US-equity trading-session classification, shared by every US broker connector
 * (Alpaca, Tradier, Schwab, TradeStation, Webull).
 *
 * A broker that exposes an authoritative open/closed flag + next open/close
 * (e.g. a clock endpoint) is exact for `open`/`closed`; the pre/post windows
 * are classified from the New-York wall clock as a best-effort signal. The
 * authoritative exchange calendar (PRD equities-v1 §12 Q3) lands later as a
 * core service; until then `open`/`closed` is exact and `pre`/`post` advisory.
 */
import type { MarketSession } from './market.js';

const NY_TZ = 'America/New_York';

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

interface EtParts {
  weekday: number; // 0=Sun .. 6=Sat
  minutes: number; // minutes since ET midnight
  yyyymmdd: string;
}

/** Decompose an instant into New-York weekday / minute-of-day / calendar date. */
export function etParts(date: Date): EtParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  return {
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    minutes: hour * 60 + Number(get('minute')),
    yyyymmdd: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

const PRE_OPEN = 4 * 60;       // 04:00 ET
const REG_OPEN = 9 * 60 + 30;  // 09:30 ET
const REG_CLOSE = 16 * 60;     // 16:00 ET
const POST_CLOSE = 20 * 60;    // 20:00 ET

export interface UsClock {
  isOpen: boolean;
  /** ISO 8601 next regular open / close, if the broker provides them. */
  nextOpen?: string;
  nextClose?: string;
}

/** Classify a US-equity session from a broker's open/closed flag + the clock. */
export function classifyUsEquitySession(clock: UsClock, now: Date = new Date()): MarketSession {
  const base: MarketSession = {
    status: clock.isOpen ? 'open' : 'closed',
    nextOpen: clock.nextOpen,
    nextClose: clock.nextClose,
    timezone: NY_TZ,
  };
  if (clock.isOpen) return base;

  const { weekday, minutes, yyyymmdd } = etParts(now);
  if (weekday < 1 || weekday > 5) return base; // weekend → closed

  // Only call it 'pre' when regular trading opens later *today* — rejects
  // holidays, where the broker's next open is a future day.
  if (minutes >= PRE_OPEN && minutes < REG_OPEN) {
    const opensToday = clock.nextOpen ? etParts(new Date(clock.nextOpen)).yyyymmdd === yyyymmdd : true;
    if (opensToday) return { ...base, status: 'pre' };
  }
  if (minutes >= REG_CLOSE && minutes < POST_CLOSE) {
    return { ...base, status: 'post' };
  }
  return base;
}
