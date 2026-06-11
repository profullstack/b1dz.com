/**
 * US-equity trading-session classification.
 *
 * Alpaca's /v2/clock is authoritative for open/closed (it already accounts for
 * the exchange calendar — holidays, half-days). It does not, however, tell us
 * whether a *closed* market is in the pre- or post-market window. We classify
 * that from the New-York wall clock as a best-effort signal.
 *
 * This is intentionally a connector-local approximation. The authoritative
 * exchange calendar (PRD §12 open question 3) lands as a core service feeding
 * the session-aware scheduler; until then `pre`/`post` is advisory and `open`/
 * `closed` is exact.
 */
import type { MarketSession, AlpacaClock } from './types.js';

const NY_TZ = 'America/New_York';

interface EtParts {
  weekday: number; // 0=Sun .. 6=Sat
  minutes: number; // minutes since ET midnight
  yyyymmdd: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

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
  if (hour === 24) hour = 0; // some engines render midnight as 24
  const minute = Number(get('minute'));
  return {
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    minutes: hour * 60 + minute,
    yyyymmdd: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

const PRE_OPEN = 4 * 60;       // 04:00 ET
const REG_OPEN = 9 * 60 + 30;  // 09:30 ET
const REG_CLOSE = 16 * 60;     // 16:00 ET
const POST_CLOSE = 20 * 60;    // 20:00 ET

/** Map an Alpaca clock (plus the current instant) to a MarketSession. */
export function sessionFromClock(clock: AlpacaClock, now: Date = new Date()): MarketSession {
  const base: MarketSession = {
    status: clock.is_open ? 'open' : 'closed',
    nextOpen: clock.next_open,
    nextClose: clock.next_close,
    timezone: NY_TZ,
  };
  if (clock.is_open) return base;

  const { weekday, minutes, yyyymmdd } = etParts(now);
  const isWeekday = weekday >= 1 && weekday <= 5;
  if (!isWeekday) return base; // weekend → closed

  // Only treat the pre-market window as 'pre' when regular trading actually
  // opens later today — this rejects holidays, where next_open is a future day.
  const nextOpenDate = etParts(new Date(clock.next_open)).yyyymmdd;
  if (minutes >= PRE_OPEN && minutes < REG_OPEN && nextOpenDate === yyyymmdd) {
    return { ...base, status: 'pre' };
  }
  if (minutes >= REG_CLOSE && minutes < POST_CLOSE) {
    return { ...base, status: 'post' };
  }
  return base;
}
