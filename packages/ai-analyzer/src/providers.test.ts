import { describe, it, expect, vi } from 'vitest';
import { analyze } from './index.js';
import { buildUserPrompt, extractJson, type FetchLike } from './providers.js';

const input = {
  pair: 'BTC-USD',
  exchange: 'kraken',
  lastPrice: 65000,
  closes: [64000, 64500, 65000],
  deterministicSignal: { side: 'buy' as const, strength: 0.8, reason: 'trend up' },
};

const fakeFetch = (payload: unknown, ok = true, status = 200): FetchLike =>
  vi.fn(async () => ({ ok, status, text: async () => JSON.stringify(payload) }));

describe('extractJson', () => {
  it('pulls a JSON object out of surrounding prose', () => {
    expect(extractJson('here you go: {"a":1} cheers')).toEqual({ a: 1 });
  });
  it('returns {} on garbage', () => {
    expect(extractJson('no json here')).toEqual({});
    expect(extractJson('{broken')).toEqual({});
  });
});

describe('buildUserPrompt', () => {
  it('includes pair, price, closes and the deterministic signal', () => {
    const p = buildUserPrompt(input);
    expect(p).toContain('BTC-USD');
    expect(p).toContain('65000');
    expect(p).toContain('buy');
  });
});

describe('analyze (anthropic)', () => {
  it('parses a Messages API response into a normalized analysis', async () => {
    const fetchImpl = fakeFetch({
      content: [{ type: 'text', text: '{"regime":"trending","bias":"long","confidence":0.9,"rationale":"uptrend"}' }],
    });
    const a = await analyze(input, { provider: 'anthropic', apiKey: 'sk-ant-x', fetchImpl });
    expect(a.provider).toBe('anthropic');
    expect(a.bias).toBe('long');
    expect(a.confidence).toBe(0.9);
    expect(a.regime).toBe('trending');
  });

  it('throws on a non-200 response', async () => {
    const fetchImpl = fakeFetch({ error: 'bad key' }, false, 401);
    await expect(analyze(input, { provider: 'anthropic', apiKey: 'bad', fetchImpl })).rejects.toThrow(/anthropic http 401/);
  });
});

describe('analyze (openai)', () => {
  it('parses a chat-completions response', async () => {
    const fetchImpl = fakeFetch({
      choices: [{ message: { content: '{"regime":"ranging","bias":"neutral","confidence":0.2,"rationale":"chop"}' } }],
    });
    const a = await analyze(input, { provider: 'openai', apiKey: 'sk-x', fetchImpl });
    expect(a.provider).toBe('openai');
    expect(a.bias).toBe('neutral');
    expect(a.regime).toBe('ranging');
  });
});
