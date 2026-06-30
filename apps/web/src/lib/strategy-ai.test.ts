import { describe, it, expect, vi } from 'vitest';
import { generateStrategy, type FetchLike, type GenerateInput } from './strategy-ai';

const input: GenerateInput = {
  niches: 'AI, semiconductors',
  goal: 'steady growth',
  knobs: { risk: 7, horizon: 4, frequency: 6, assetFocus: 8 },
};

/** A fetch stub that returns the given model text in Anthropic's response shape. */
function fetchReturning(...texts: string[]): FetchLike {
  let i = 0;
  return vi.fn(async () => {
    const text = texts[Math.min(i++, texts.length - 1)]!;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [{ type: 'text', text }] }),
    };
  });
}

const validDoc = {
  definition: {
    tsp: '0.1',
    id: 'ai-rsi',
    name: 'AI RSI Dip',
    assetClasses: ['crypto'],
    definition: { kind: 'template', template: 'mean-reversion', params: { oversold: 35 } },
  },
  description: 'Buys oversold dips in AI/semis names.',
};

describe('generateStrategy', () => {
  it('returns a validated definition + description on a good response', async () => {
    const fetchImpl = fetchReturning(JSON.stringify(validDoc));
    const res = await generateStrategy(input, { apiKey: 'sk-test', fetchImpl });
    expect((res.definition as { id: string }).id).toBe('ai-rsi');
    expect(res.description).toMatch(/oversold/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('repairs once when the first document is invalid', async () => {
    const bad = JSON.stringify({ definition: { tsp: '0.1', id: 'x', name: 'X' }, description: '' }); // missing definition body
    const fetchImpl = fetchReturning(bad, JSON.stringify(validDoc));
    const res = await generateStrategy(input, { apiKey: 'sk-test', fetchImpl });
    expect((res.definition as { id: string }).id).toBe('ai-rsi');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws after a second invalid attempt', async () => {
    const bad = JSON.stringify({ definition: { kind: 'nope' } });
    const fetchImpl = fetchReturning(bad, bad);
    await expect(generateStrategy(input, { apiKey: 'sk-test', fetchImpl })).rejects.toThrow(/invalid strategy/);
  });

  it('tolerates prose around the JSON object', async () => {
    const text = `Here you go:\n${JSON.stringify(validDoc)}\nHope that helps!`;
    const res = await generateStrategy(input, { apiKey: 'sk-test', fetchImpl: fetchReturning(text) });
    expect((res.definition as { id: string }).id).toBe('ai-rsi');
  });

  it('throws without an API key', async () => {
    await expect(
      generateStrategy(input, { apiKey: '', fetchImpl: fetchReturning('{}') }),
    ).rejects.toThrow(/not configured/);
  });

  it('surfaces an HTTP error from the model', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    await expect(generateStrategy(input, { apiKey: 'sk-test', fetchImpl })).rejects.toThrow(/http 500/);
  });
});
