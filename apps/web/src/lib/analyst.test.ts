import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@b1dz/research';
import { pickCards, TECHNICAL_QUESTION } from './analyst';

const hit = (dashboard: string, symbol: string): SearchHit => ({ kind: 'security', label: symbol, dashboard, params: { symbol } });

describe('analyst card picking', () => {
  it('sends chart questions about a stock to the technicals cards', async () => {
    const cards = await pickCards('where is NVDA support?', { search: async () => [hit('company', 'NVDA')] });
    expect(cards.map((c) => c.id)).toEqual(['technicals.summary', 'technicals.trendlines', 'technicals.patterns']);
    expect(cards[0].params).toEqual({ symbol: 'NVDA' });
  });

  it('uses the coin cards for a coin', async () => {
    const cards = await pickCards('is BTC breaking out of the triangle?', { search: async () => [hit('crypto', 'BTC-USD')] });
    expect(cards.map((c) => c.id)).toEqual(['crypto.technical-summary', 'crypto.trendlines', 'crypto.patterns']);
  });

  it('keeps the ticker overview for other questions', async () => {
    const cards = await pickCards('how did NVDA earnings look?', { search: async () => [hit('company', 'NVDA')] });
    expect(cards[0].id).not.toMatch(/^technicals\./);
  });

  it('recognises technical wording', () => {
    for (const q of ['RSI on AAPL', 'head and shoulders on SPY', 'fib levels for ETH', 'is it oversold']) expect(TECHNICAL_QUESTION.test(q), q).toBe(true);
    expect(TECHNICAL_QUESTION.test('what is the dividend yield')).toBe(false);
  });
});
