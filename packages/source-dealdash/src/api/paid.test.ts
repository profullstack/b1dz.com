import { afterEach, describe, expect, it } from 'vitest';
import { x402Client } from './paid.js';

/* The payer key comes from the running user's unlocked tick, never from import time. */
const ENV = ['X402', 'PRIVATE_KEY'].join('_');

describe('x402Client', () => {
  afterEach(() => {
    delete process.env[ENV];
  });

  it('is null with no key in the (overlaid) environment', () => {
    delete process.env[ENV];
    expect(x402Client()).toBeNull();
  });

  it('reads the key per call, so a key set for one tick does not outlive it', () => {
    process.env[ENV] = `0x${'11'.repeat(32)}`;
    expect(x402Client()).not.toBeNull();
    delete process.env[ENV];
    expect(x402Client()).toBeNull();
  });
});
