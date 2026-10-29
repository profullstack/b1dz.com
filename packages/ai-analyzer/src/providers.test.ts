import { describe, it, expect, vi } from 'vitest';
import { analyze } from './index.js';
import {
  buildUserPrompt,
  clearModelCache,
  extractJson,
  FALLBACK_ANTHROPIC_MODELS,
  resolveAnthropicModel,
  supportsEffort,
  type FetchLike,
} from './providers.js';

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

describe('resolveAnthropicModel', () => {
  const models = (data: Array<{ id: string; created_at: string }>): FetchLike =>
    vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data }) }));
  const catalogue = [
    { id: 'claude-sonnet-5-5', created_at: '2026-09-01T00:00:00Z' },
    { id: 'claude-opus-5', created_at: '2026-05-01T00:00:00Z' },
    { id: 'claude-opus-6', created_at: '2027-03-01T00:00:00Z' },
    { id: 'claude-opus-5-5', created_at: '2026-09-01T00:00:00Z' },
  ];

  it('resolves `latest` to the newest Opus and caches it', async () => {
    clearModelCache();
    const fetchImpl = models(catalogue);
    expect(await resolveAnthropicModel('k', 'latest', fetchImpl)).toBe('claude-opus-6');
    expect(await resolveAnthropicModel('k', undefined, fetchImpl)).toBe('claude-opus-6');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('tracks a named family', async () => {
    clearModelCache();
    expect(await resolveAnthropicModel('k', 'latest-sonnet', models(catalogue))).toBe('claude-sonnet-5-5');
  });

  it('passes a concrete id through without a lookup', async () => {
    const fetchImpl = models(catalogue);
    expect(await resolveAnthropicModel('k', 'claude-opus-5', fetchImpl)).toBe('claude-opus-5');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to the pinned id when the models API fails', async () => {
    clearModelCache();
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, text: async () => 'nope' });
    expect(await resolveAnthropicModel('k', 'latest', fetchImpl)).toBe(FALLBACK_ANTHROPIC_MODELS.opus);
  });

  it('only sends effort to models that accept it', () => {
    expect(supportsEffort('claude-opus-5-5')).toBe(true);
    expect(supportsEffort('claude-haiku-5-5')).toBe(true);
    expect(supportsEffort('claude-sonnet-4-6')).toBe(true);
    expect(supportsEffort('claude-haiku-4-5-20251001')).toBe(false);
    expect(supportsEffort('claude-sonnet-4-5')).toBe(false);
  });
});
