import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { InMemoryNonceStore, NonceManager } from './nonce.js';

const ADDR_A: Address = '0x1111111111111111111111111111111111111111';
const ADDR_B: Address = '0x2222222222222222222222222222222222222222';

function mkClient(initialCount: number) {
  let calls = 0;
  return {
    client: {
      getTransactionCount: async () => {
        calls++;
        return initialCount;
      },
    },
    get calls() { return calls; },
  };
}

describe('NonceManager', () => {
  it('returns the on-chain pending count on first allocation', async () => {
    const { client } = mkClient(7);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nm = new NonceManager({ clients: { base: client as any } });
    expect(await nm.next('base', ADDR_A)).toBe(7);
  });

  it('increments monotonically across allocations from the same wallet', async () => {
    const { client } = mkClient(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nm = new NonceManager({ clients: { base: client as any } });
    expect(await nm.next('base', ADDR_A)).toBe(3);
    expect(await nm.next('base', ADDR_A)).toBe(4);
    expect(await nm.next('base', ADDR_A)).toBe(5);
  });

  it('maintains separate counters per (chain, address)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base = { getTransactionCount: async () => 10 } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eth = { getTransactionCount: async () => 20 } as any;
    const nm = new NonceManager({ clients: { base, ethereum: eth } });
    expect(await nm.next('base', ADDR_A)).toBe(10);
    expect(await nm.next('ethereum', ADDR_A)).toBe(20);
    expect(await nm.next('base', ADDR_B)).toBe(10);
    expect(await nm.next('base', ADDR_A)).toBe(11);
  });

  it('serializes concurrent allocations for the same wallet', async () => {
    const { client } = mkClient(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nm = new NonceManager({ clients: { base: client as any } });
    const [a, b, c] = await Promise.all([
      nm.next('base', ADDR_A),
      nm.next('base', ADDR_A),
      nm.next('base', ADDR_A),
    ]);
    // All three must be distinct and consecutive starting from 0.
    expect([a, b, c].sort((x, y) => x - y)).toEqual([0, 1, 2]);
  });

  it('resync forces the next allocation to re-read from chain', async () => {
    let count = 5;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = { getTransactionCount: async () => count } as any;
    const nm = new NonceManager({ clients: { base: client } });
    expect(await nm.next('base', ADDR_A)).toBe(5);
    expect(await nm.next('base', ADDR_A)).toBe(6);
    // Chain advanced (e.g. a tx landed outside our manager).
    count = 12;
    await nm.resync('base', ADDR_A);
    expect(await nm.next('base', ADDR_A)).toBe(12);
  });

  it('persisted store is preferred over the on-chain count on cold start', async () => {
    const store = new InMemoryNonceStore();
    await store.save('base', ADDR_A, 99);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = { getTransactionCount: async () => 0 } as any;
    const nm = new NonceManager({ clients: { base: client }, store });
    expect(await nm.next('base', ADDR_A)).toBe(99);
    expect(await store.load('base', ADDR_A)).toBe(100);
  });

  it('throws for unconfigured chain', async () => {
    const nm = new NonceManager({ clients: {} });
    await expect(nm.next('ethereum', ADDR_A)).rejects.toThrow(/no client/);
  });
});
