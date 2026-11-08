import { describe, expect, it } from 'vitest';
import { formatKrakenPrice } from './kraken-private.js';

describe('formatKrakenPrice', () => {
  it('rounds to the pair price precision (BTC/USD takes 1 decimal)', () => {
    expect(formatKrakenPrice(77289.4567, 1)).toBe('77289.5');
    expect(formatKrakenPrice(2236.887, 2)).toBe('2236.89');
    expect(formatKrakenPrice(0.123456, 5)).toBe('0.12346');
  });
  it('falls back to 2 decimals when precision is unknown', () => {
    expect(formatKrakenPrice(91.237, null)).toBe('91.24');
    expect(formatKrakenPrice(91.237, undefined)).toBe('91.24');
  });
});
