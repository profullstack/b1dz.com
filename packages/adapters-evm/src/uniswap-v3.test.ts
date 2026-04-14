import { describe, expect, it, vi } from 'vitest';
import { UniswapV3Adapter, UNISWAP_V3_FEE_TIERS } from './uniswap-v3.js';

function mockClient(handler: (args: unknown) => Promise<unknown>): unknown {
  return {
    async getBlockNumber() { return 123n; },
    simulateContract: vi.fn(async (args: unknown) => handler(args)),
  };
}

function makeAdapter(simulate: (fee: number, amountIn: bigint) => { amountOut: bigint; gas: bigint } | 'revert') {
  const client = mockClient(async (args: unknown) => {
    const call = args as { args: readonly [{ fee: number; amountIn: bigint }] };
    const { fee, amountIn } = call.args[0];
    const outcome = simulate(fee, amountIn);
    if (outcome === 'revert') throw new Error('execution reverted');
    return { result: [outcome.amountOut, 0n, 0, outcome.gas] };
  });
  return new UniswapV3Adapter({ chain: 'base', client });
}

describe('UniswapV3Adapter', () => {
  it('health returns ok when getBlockNumber resolves', async () => {
    const adapter = new UniswapV3Adapter({ chain: 'base', client: mockClient(async () => ({ result: [0n, 0n, 0, 0n] })) });
    const h = await adapter.health();
    expect(h.ok).toBe(true);
  });

  it('health returns not-ok when block number is 0', async () => {
    const client: unknown = {
      async getBlockNumber() { return 0n; },
      simulateContract: async () => ({ result: [0n, 0n, 0, 0n] }),
    };
    const adapter = new UniswapV3Adapter({ chain: 'base', client });
    const h = await adapter.health();
    expect(h.ok).toBe(false);
  });

  it('rejects unsupported pairs', async () => {
    const adapter = makeAdapter(() => ({ amountOut: 1n, gas: 100_000n }));
    expect(await adapter.supports({ pair: 'FAKE-NOTREAL', side: 'sell', amountIn: '1' })).toBe(false);
  });

  it('rejects supports() when chain does not match', async () => {
    const adapter = makeAdapter(() => ({ amountOut: 1n, gas: 100_000n }));
    expect(await adapter.supports({ pair: 'ETH-USDC', side: 'sell', amountIn: '1', chain: 'arbitrum' })).toBe(false);
  });

  it('supports ETH-USDC on its configured chain', async () => {
    const adapter = makeAdapter(() => ({ amountOut: 1n, gas: 100_000n }));
    expect(await adapter.supports({ pair: 'ETH-USDC', side: 'sell', amountIn: '1' })).toBe(true);
  });

  it('quote returns null when every fee tier reverts', async () => {
    const adapter = makeAdapter(() => 'revert');
    const q = await adapter.quote({ pair: 'ETH-USDC', side: 'sell', amountIn: '1' });
    expect(q).toBeNull();
  });

  it('quote picks the fee tier with the best amountOut', async () => {
    const adapter = makeAdapter((fee) => {
      // 0.05% returns 1000 USDC, 0.3% returns 1100, 1% returns 500, 0.01% reverts.
      if (fee === 100) return 'revert';
      if (fee === 500) return { amountOut: 1_000_000_000n, gas: 200_000n };  // 1000 USDC (6 decimals)
      if (fee === 3000) return { amountOut: 1_100_000_000n, gas: 200_000n }; // 1100 USDC
      if (fee === 10000) return { amountOut: 500_000_000n, gas: 200_000n };  // 500 USDC
      return 'revert';
    });
    const q = await adapter.quote({ pair: 'ETH-USDC', side: 'sell', amountIn: '1' });
    expect(q).not.toBeNull();
    expect(Number.parseFloat(q!.amountOut)).toBe(1100); // best tier wins
    const summary = q!.routeSummary.join(' ');
    expect(summary).toMatch(/0\.30%/); // 3000 bps fee tier
  });

  it('quote includes approval metadata for non-native token in', async () => {
    const adapter = makeAdapter(() => ({ amountOut: 1n, gas: 100_000n }));
    const q = await adapter.quote({ pair: 'ETH-USDC', side: 'buy', amountIn: '1000' });
    expect(q?.allowanceRequired).toBe(true);
    // USDC on base
    expect(q?.approvalToken?.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });

  it('exposes router + quoter addresses for later execution wiring', () => {
    const adapter = makeAdapter(() => ({ amountOut: 1n, gas: 100_000n }));
    expect(adapter.routerAddress().startsWith('0x')).toBe(true);
    expect(adapter.quoterAddress().startsWith('0x')).toBe(true);
  });

  it('queries all configured fee tiers', async () => {
    const calls: number[] = [];
    const client: unknown = {
      async getBlockNumber() { return 1n; },
      simulateContract: vi.fn(async (args: unknown) => {
        const call = args as { args: readonly [{ fee: number }] };
        calls.push(call.args[0].fee);
        return { result: [1n, 0n, 0, 100_000n] };
      }),
    };
    const adapter = new UniswapV3Adapter({ chain: 'base', client });
    await adapter.quote({ pair: 'ETH-USDC', side: 'sell', amountIn: '1' });
    expect(new Set(calls)).toEqual(new Set(UNISWAP_V3_FEE_TIERS));
  });

  it('custom feeTiers restricts the set of pools queried', async () => {
    const calls: number[] = [];
    const client: unknown = {
      async getBlockNumber() { return 1n; },
      simulateContract: vi.fn(async (args: unknown) => {
        const call = args as { args: readonly [{ fee: number }] };
        calls.push(call.args[0].fee);
        return { result: [1n, 0n, 0, 100_000n] };
      }),
    };
    const adapter = new UniswapV3Adapter({ chain: 'base', client, feeTiers: [500, 3000] });
    await adapter.quote({ pair: 'ETH-USDC', side: 'sell', amountIn: '1' });
    expect([...calls].sort((a, b) => a - b)).toEqual([500, 3000]);
  });

  it('throws on unsupported chain at construction', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new UniswapV3Adapter({ chain: 'avalanche' as any, client: mockClient(async () => null) })).toThrow(/not configured/);
  });

  it('gasUsd uses the injected gas oracle instead of the 1-gwei fallback', async () => {
    const client = mockClient(async (args: unknown) => {
      const call = args as { args: readonly [{ fee: number }] };
      if (call.args[0].fee !== 500) return { result: [0n, 0n, 0, 0n] };
      // 1 ETH in → 2500 USDC out, 150k gas
      return { result: [2_500_000_000n, 0n, 0, 150_000n] };
    });
    // Oracle reports 20 gwei → should dominate the 1-gwei fallback.
    const gasOracle = {
      getFeeData: async () => ({
        chain: 'base' as const,
        maxFeePerGas: 20_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        baseFeePerGas: 19_000_000_000n,
        observedAt: Date.now(),
      }),
    };
    const adapter = new UniswapV3Adapter({
      chain: 'base',
      client,
      feeTiers: [500],
      gasOracle,
      nativeUsd: () => 2_500,
      gasBufferBps: 0, // disable buffer so the math is exact
    });
    const q = await adapter.quote({ pair: 'ETH-USDC', side: 'sell', amountIn: '1' });
    // 150000 * 20e9 wei = 3e15 wei = 0.003 ETH = $7.50 at $2500/ETH
    expect(q?.gasUsd).toBeCloseTo(7.5, 3);
  });

  it('gas buffer inflates the reported gasUsd by the configured bps', async () => {
    const client = mockClient(async () => ({ result: [2_500_000_000n, 0n, 0, 150_000n] }));
    const gasOracle = {
      getFeeData: async () => ({
        chain: 'base' as const,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 100_000_000n,
        baseFeePerGas: 900_000_000n,
        observedAt: Date.now(),
      }),
    };
    const a0 = new UniswapV3Adapter({
      chain: 'base', client, feeTiers: [500],
      gasOracle, nativeUsd: () => 2_500, gasBufferBps: 0,
    });
    const a20 = new UniswapV3Adapter({
      chain: 'base', client, feeTiers: [500],
      gasOracle, nativeUsd: () => 2_500, gasBufferBps: 2_000,
    });
    const q0 = await a0.quote({ pair: 'ETH-USDC', side: 'sell', amountIn: '1' });
    const q20 = await a20.quote({ pair: 'ETH-USDC', side: 'sell', amountIn: '1' });
    expect(q20!.gasUsd).toBeCloseTo(q0!.gasUsd * 1.2, 4);
  });

  it('falls back to the hardcoded 1-gwei path when no gas oracle is wired', async () => {
    const adapter = makeAdapter((fee) => {
      if (fee === 500) return { amountOut: 2_500_000_000n, gas: 150_000n };
      return 'revert';
    });
    const q = await adapter.quote({ pair: 'ETH-USDC', side: 'sell', amountIn: '1' });
    // 150000 * 1e9 wei = 1.5e14 wei = 0.00015 ETH = $0.375 @ $2500
    expect(q?.gasUsd).toBeCloseTo(0.375, 3);
  });
});
