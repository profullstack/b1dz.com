import { describe, it, expect } from 'vitest';
import { sessionFromClock } from './session.js';
import type { AlpacaClock } from './alpaca-client.js';

// A normal trading Thursday, 2026-06-11. ET is UTC-4 (EDT) in June.
const clock = (over: Partial<AlpacaClock>): AlpacaClock => ({
  timestamp: '2026-06-11T14:30:00Z',
  is_open: false,
  next_open: '2026-06-11T13:30:00Z', // 09:30 ET same day
  next_close: '2026-06-11T20:00:00Z', // 16:00 ET same day
  ...over,
});

describe('sessionFromClock', () => {
  it('reports open when the clock says open', () => {
    const s = sessionFromClock(clock({ is_open: true }), new Date('2026-06-11T15:00:00Z'));
    expect(s.status).toBe('open');
    expect(s.timezone).toBe('America/New_York');
    expect(s.nextClose).toBe('2026-06-11T20:00:00Z');
  });

  it('reports pre during 04:00–09:30 ET on a day that opens later', () => {
    // 08:00 ET == 12:00 UTC
    const s = sessionFromClock(clock({}), new Date('2026-06-11T12:00:00Z'));
    expect(s.status).toBe('pre');
  });

  it('reports post during 16:00–20:00 ET', () => {
    // 17:00 ET == 21:00 UTC
    const s = sessionFromClock(clock({ next_open: '2026-06-12T13:30:00Z' }), new Date('2026-06-11T21:00:00Z'));
    expect(s.status).toBe('post');
  });

  it('reports closed in the overnight gap', () => {
    // 02:00 ET == 06:00 UTC
    const s = sessionFromClock(clock({}), new Date('2026-06-11T06:00:00Z'));
    expect(s.status).toBe('closed');
  });

  it('does not call a holiday "pre" (next_open is a future day)', () => {
    // 08:00 ET on a holiday: next_open rolls to the following day.
    const s = sessionFromClock(
      clock({ next_open: '2026-06-12T13:30:00Z' }),
      new Date('2026-06-11T12:00:00Z'),
    );
    expect(s.status).toBe('closed');
  });

  it('reports closed on weekends', () => {
    // 2026-06-13 is a Saturday, 15:00 UTC == 11:00 ET
    const s = sessionFromClock(
      clock({ next_open: '2026-06-15T13:30:00Z' }),
      new Date('2026-06-13T15:00:00Z'),
    );
    expect(s.status).toBe('closed');
  });
});
