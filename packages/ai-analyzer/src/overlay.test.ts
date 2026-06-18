import { describe, it, expect } from 'vitest';
import {
  aiSizeMultiplier,
  coerceAnalysis,
  RateLimiter,
  AI_SIZE_MIN,
  AI_SIZE_MAX,
  type AiAnalysis,
} from './overlay.js';

const NOW = 1_000_000;
const base = (over: Partial<AiAnalysis> = {}): AiAnalysis => ({
  regime: 'trending',
  confidence: 1,
  bias: 'long',
  rationale: 'x',
  ts: NOW,
  provider: 'anthropic',
  model: 'm',
  ...over,
});

describe('aiSizeMultiplier', () => {
  it('returns 1 with no analysis', () => {
    expect(aiSizeMultiplier(null, NOW)).toBe(1);
  });

  it('returns 1 when analysis is stale', () => {
    expect(aiSizeMultiplier(base({ ts: NOW - 10 * 60_000 }), NOW)).toBe(1);
  });

  it('returns 1 on neutral bias', () => {
    expect(aiSizeMultiplier(base({ bias: 'neutral' }), NOW)).toBe(1);
  });

  it('scales up on a confident long in a trend (capped at MAX)', () => {
    expect(aiSizeMultiplier(base({ bias: 'long', confidence: 1, regime: 'trending' }), NOW)).toBe(AI_SIZE_MAX);
  });

  it('scales down on a confident short but never flips below MIN', () => {
    const m = aiSizeMultiplier(base({ bias: 'short', confidence: 1, regime: 'trending' }), NOW);
    expect(m).toBe(AI_SIZE_MIN);
    expect(m).toBeGreaterThan(0);
  });

  it('damps magnitude in a volatile regime', () => {
    const trend = aiSizeMultiplier(base({ bias: 'long', confidence: 1, regime: 'trending' }), NOW);
    const vol = aiSizeMultiplier(base({ bias: 'long', confidence: 1, regime: 'volatile' }), NOW);
    expect(vol).toBeLessThan(trend);
    expect(vol).toBeGreaterThanOrEqual(1);
  });

  it('low confidence stays near 1', () => {
    const m = aiSizeMultiplier(base({ bias: 'long', confidence: 0.05, regime: 'trending' }), NOW);
    expect(m).toBeGreaterThan(1);
    expect(m).toBeLessThan(1.1);
  });

  it('clamps the multiplier within [MIN, MAX]', () => {
    for (const bias of ['long', 'short', 'neutral'] as const) {
      for (const conf of [0, 0.5, 1, 2, -1]) {
        const m = aiSizeMultiplier(base({ bias, confidence: conf }), NOW);
        expect(m).toBeGreaterThanOrEqual(AI_SIZE_MIN);
        expect(m).toBeLessThanOrEqual(AI_SIZE_MAX);
      }
    }
  });
});

describe('coerceAnalysis', () => {
  const meta = { provider: 'anthropic' as const, model: 'm', ts: NOW };

  it('passes through valid JSON', () => {
    const a = coerceAnalysis({ regime: 'ranging', bias: 'short', confidence: 0.7, rationale: 'r' }, meta);
    expect(a).toMatchObject({ regime: 'ranging', bias: 'short', confidence: 0.7, rationale: 'r' });
  });

  it('defaults unknown/garbage fields safely', () => {
    const a = coerceAnalysis({ regime: 'banana', bias: 'sideways', confidence: 'high' }, meta);
    expect(a.regime).toBe('unknown');
    expect(a.bias).toBe('neutral');
    expect(a.confidence).toBe(0);
  });

  it('clamps confidence and truncates rationale', () => {
    const a = coerceAnalysis({ confidence: 5, rationale: 'x'.repeat(999) }, meta);
    expect(a.confidence).toBe(1);
    expect(a.rationale.length).toBe(500);
  });

  it('handles null/undefined input', () => {
    expect(coerceAnalysis(null, meta).bias).toBe('neutral');
    expect(coerceAnalysis(undefined, meta).regime).toBe('unknown');
  });
});

describe('RateLimiter', () => {
  it('allows up to maxPerMin then blocks within the window', () => {
    const rl = new RateLimiter(2);
    expect(rl.allow(0)).toBe(true);
    expect(rl.allow(1)).toBe(true);
    expect(rl.allow(2)).toBe(false);
  });

  it('refills after the window slides', () => {
    const rl = new RateLimiter(1);
    expect(rl.allow(0)).toBe(true);
    expect(rl.allow(30_000)).toBe(false);
    expect(rl.allow(61_000)).toBe(true);
  });

  it('treats maxPerMin <= 0 as unlimited', () => {
    const rl = new RateLimiter(0);
    for (let i = 0; i < 100; i++) expect(rl.allow(i)).toBe(true);
  });
});
