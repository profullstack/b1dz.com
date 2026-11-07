import { afterEach, describe, it, expect, vi } from 'vitest';
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
    const res = await generateStrategy(input, { apiKey: 'sk-test', model: 'claude-opus-5-5', fetchImpl });
    expect((res.definition as { id: string }).id).toBe('ai-rsi');
    expect(res.description).toMatch(/oversold/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('repairs once when the first document is invalid', async () => {
    const bad = JSON.stringify({ definition: { tsp: '0.1', id: 'x', name: 'X' }, description: '' }); // missing definition body
    const fetchImpl = fetchReturning(bad, JSON.stringify(validDoc));
    const res = await generateStrategy(input, { apiKey: 'sk-test', model: 'claude-opus-5-5', fetchImpl });
    expect((res.definition as { id: string }).id).toBe('ai-rsi');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws after a second invalid attempt', async () => {
    const bad = JSON.stringify({ definition: { kind: 'nope' } });
    const fetchImpl = fetchReturning(bad, bad);
    await expect(generateStrategy(input, { apiKey: 'sk-test', model: 'claude-opus-5-5', fetchImpl })).rejects.toThrow(/invalid strategy/);
  });

  it('tolerates prose around the JSON object', async () => {
    const text = `Here you go:\n${JSON.stringify(validDoc)}\nHope that helps!`;
    const res = await generateStrategy(input, { apiKey: 'sk-test', model: 'claude-opus-5-5', fetchImpl: fetchReturning(text) });
    expect((res.definition as { id: string }).id).toBe('ai-rsi');
  });

  it('throws without an API key', async () => {
    await expect(
      generateStrategy(input, { apiKey: '', fetchImpl: fetchReturning('{}') }),
    ).rejects.toThrow(/not configured/);
  });

  it('surfaces an HTTP error from the model', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    await expect(generateStrategy(input, { apiKey: 'sk-test', model: 'claude-opus-5-5', fetchImpl })).rejects.toThrow(/http 500/);
  });

  describe('fallback provider', () => {
    const fallback = { baseUrl: 'https://cf.example/ai/v1/', apiKey: 'cf-test', model: '@cf/openai/gpt-oss-120b' };
    const openAiOk = (text: string) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }),
    });

    it('retries on the fallback when Claude is over its spend limit', async () => {
      const urls: string[] = [];
      const fetchImpl: FetchLike = vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes('anthropic')) {
          return { ok: false, status: 400, text: async () => 'You have reached your specified API usage limits.' };
        }
        return openAiOk(JSON.stringify(validDoc));
      });
      const res = await generateStrategy(input, { apiKey: 'sk-test', model: 'claude-opus-5-5', fetchImpl, fallback });
      expect((res.definition as { id: string }).id).toBe('ai-rsi');
      expect(urls.at(-1)).toBe('https://cf.example/ai/v1/chat/completions');
    });

    it('uses the fallback alone when no Claude key is set', async () => {
      const fetchImpl: FetchLike = vi.fn(async () => openAiOk(JSON.stringify(validDoc)));
      const res = await generateStrategy(input, { apiKey: '', fetchImpl, fallback });
      expect((res.definition as { id: string }).id).toBe('ai-rsi');
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('does not fall back on a non-quota failure', async () => {
      const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
      await expect(
        generateStrategy(input, { apiKey: 'sk-test', model: 'claude-opus-5-5', fetchImpl, fallback }),
      ).rejects.toThrow(/anthropic http 500/);
      expect(fetchImpl).toHaveBeenCalledOnce();
    });
  });
});

describe('generateStrategy on c0mpute', () => {
  afterEach(() => {
    delete process.env.C0MPUTE_API_KEY;
    delete process.env.C0MPUTE_DISABLED;
  });

  const chat = (text: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: text } }] }),
  });
  const claude = (text: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ content: [{ type: 'text', text }] }),
  });
  const refused = (status: number, message: string) => ({ ok: false, status, text: async () => message });
  const opts = (fetchImpl: FetchLike) => ({ apiKey: 'sk-test', model: 'claude-opus-5-5', fetchImpl });

  it('goes to c0mpute first, peers only, and never touches the operator key', async () => {
    process.env.C0MPUTE_API_KEY = 'ik_live_test';
    const urls: string[] = [];
    let body: { p2p_only?: boolean } = {};
    const fetchImpl: FetchLike = async (url, init) => {
      urls.push(url);
      body = JSON.parse(init.body!);
      return chat(JSON.stringify(validDoc));
    };
    const res = await generateStrategy(input, opts(fetchImpl));
    expect((res.definition as { id: string }).id).toBe('ai-rsi');
    expect(urls).toEqual(['https://infernetprotocol.com/v1/chat/completions']);
    expect(body.p2p_only).toBe(true);
  });

  it('falls back to Claude when c0mpute has no node or writes a bad document', async () => {
    process.env.C0MPUTE_API_KEY = 'ik_live_test';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const answer of [refused(503, 'no live node'), chat('{"definition":{"kind":"nope"}}')]) {
      const fetchImpl: FetchLike = async (url) =>
        url.includes('infernetprotocol') ? answer : claude(JSON.stringify(validDoc));
      const res = await generateStrategy(input, opts(fetchImpl));
      expect((res.definition as { id: string }).id).toBe('ai-rsi');
    }
  });

  it('a dead Anthropic key behind a failed c0mpute fails as it does today', async () => {
    process.env.C0MPUTE_API_KEY = 'ik_live_test';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl: FetchLike = async (url) =>
      url.includes('infernetprotocol') ? refused(503, 'no live node') : refused(400, 'Your credit balance is too low');
    await expect(generateStrategy(input, opts(fetchImpl))).rejects.toThrow(/credit balance is too low/);
  });

  it('counts as configured with no operator key, and C0MPUTE_DISABLED turns it off', async () => {
    process.env.C0MPUTE_API_KEY = 'ik_live_test';
    const fetchImpl: FetchLike = async () => chat(JSON.stringify(validDoc));
    const res = await generateStrategy(input, { apiKey: '', fetchImpl });
    expect((res.definition as { id: string }).id).toBe('ai-rsi');
    process.env.C0MPUTE_DISABLED = '1';
    await expect(generateStrategy(input, { apiKey: '', fetchImpl })).rejects.toThrow(/not configured/);
  });
});
