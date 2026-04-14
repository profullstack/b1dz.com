import { describe, expect, it } from 'vitest';
import { classifyLifecycle } from './lifecycle.js';

const NOW = 1_700_000_000_000;

describe('classifyLifecycle', () => {
  it('classifies a <1h-old bonding-curve token as new_launch', () => {
    const state = classifyLifecycle({
      complete: false,
      createdAtMs: NOW - 30 * 60_000, // 30 min ago
      now: NOW,
    });
    expect(state).toBe('new_launch');
  });

  it('classifies a >1h-old bonding-curve token as bonding_curve', () => {
    const state = classifyLifecycle({
      complete: false,
      createdAtMs: NOW - 2 * 60 * 60_000, // 2 hours ago
      now: NOW,
    });
    expect(state).toBe('bonding_curve');
  });

  it('classifies a complete curve without a pool as migrating', () => {
    const state = classifyLifecycle({
      complete: true,
      raydiumPool: null,
      pumpSwapPool: null,
      createdAtMs: NOW - 60 * 60_000,
      now: NOW,
    });
    expect(state).toBe('migrating');
  });

  it('classifies a complete curve with a Raydium pool as external_pool', () => {
    const state = classifyLifecycle({
      complete: true,
      raydiumPool: 'pool-123',
      createdAtMs: NOW - 24 * 60 * 60_000,
      now: NOW,
    });
    expect(state).toBe('external_pool');
  });

  it('classifies a complete curve with a PumpSwap pool as pumpswap', () => {
    const state = classifyLifecycle({
      complete: true,
      pumpSwapPool: 'pumpswap-abc',
      createdAtMs: NOW - 3 * 60 * 60_000,
      now: NOW,
    });
    expect(state).toBe('pumpswap');
  });

  it('prefers pumpswap over external_pool when both fields are present', () => {
    // Shouldn't happen in practice, but guards against ambiguous upstream data.
    const state = classifyLifecycle({
      complete: true,
      raydiumPool: 'r',
      pumpSwapPool: 'p',
      createdAtMs: NOW,
      now: NOW,
    });
    expect(state).toBe('pumpswap');
  });

  it('handles exactly-at-1h boundary as bonding_curve (inclusive)', () => {
    const state = classifyLifecycle({
      complete: false,
      createdAtMs: NOW - 60 * 60_000, // exactly 1h
      now: NOW,
    });
    expect(state).toBe('bonding_curve');
  });

  it('treats negative age (clock skew) as new_launch', () => {
    const state = classifyLifecycle({
      complete: false,
      createdAtMs: NOW + 5_000, // created "in the future"
      now: NOW,
    });
    expect(state).toBe('new_launch');
  });
});
