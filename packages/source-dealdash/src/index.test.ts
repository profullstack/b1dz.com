import { describe, it, expect } from 'vitest';
import { dealDashSource } from './index.js';

describe('dealDashSource (placeholder)', () => {
  it('declares the right id and poll interval', () => {
    expect(dealDashSource.id).toBe('dealdash');
    expect(dealDashSource.pollIntervalMs).toBeGreaterThan(0);
  });
});
