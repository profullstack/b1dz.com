import { describe, expect, it } from 'vitest';
import {
  ViemGasOracle,
  estimateTxCostUsd,
  isFeeDataStale,
  exceedsGasBudget,
  gasEatsTheEdge,
  isGasSpike,
  type FeeData,
} from './gas.js';

function mkFee(overrides: Partial<FeeData> = {}): FeeData {
  return {
    chain: 'base',
    maxFeePerGas: 1_000_000_000n, // 1 gwei
    maxPriorityFeePerGas: 100_000_000n,
    baseFeePerGas: 900_000_000n,
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('estimateTxCostUsd', () => {
  it('prices a 150k-gas tx at 1 gwei with ETH=$2500 at the expected USD', () => {
    const fee = mkFee({ maxFeePerGas: 1_000_000_000n });
    const cost = estimateTxCostUsd(fee, 150_000n, 2_500);
    // 150000 * 1e9 wei = 1.5e14 wei = 0.00015 ETH = $0.375
    expect(cost).toBeCloseTo(0.375, 6);
  });

  it('applies the bps safety buffer when provided', () => {
    const fee = mkFee({ maxFeePerGas: 1_000_000_000n });
    const raw = estimateTxCostUsd(fee, 150_000n, 2_500);
    const buffered = estimateTxCostUsd(fee, 150_000n, 2_500, { bufferBps: 2_000 });
    expect(buffered).toBeCloseTo(raw * 1.2, 6);
  });

  it('returns 0 when gasLimit is zero', () => {
    expect(estimateTxCostUsd(mkFee(), 0n, 2_500)).toBe(0);
  });

  it('rejects non-positive native USD', () => {
    expect(() => estimateTxCostUsd(mkFee(), 150_000n, 0)).toThrow();
    expect(() => estimateTxCostUsd(mkFee(), 150_000n, -1)).toThrow();
  });
});

describe('isFeeDataStale', () => {
  it('false when observed within the max-age window', () => {
    const fee = mkFee({ observedAt: 1_700_000_000_000 });
    expect(isFeeDataStale(fee, 10_000, 1_700_000_005_000)).toBe(false);
  });
  it('true when observed outside the max-age window', () => {
    const fee = mkFee({ observedAt: 1_700_000_000_000 });
    expect(isFeeDataStale(fee, 10_000, 1_700_000_020_000)).toBe(true);
  });
});

describe('exceedsGasBudget', () => {
  it('null when under budget', () => {
    expect(exceedsGasBudget(1.5, 5)).toBeNull();
  });
  it('returns a blocker string when over budget', () => {
    const blocker = exceedsGasBudget(7, 5);
    expect(blocker).toMatch(/gas .+ max/);
  });
});

describe('gasEatsTheEdge', () => {
  it('null when gas is a small fraction of edge', () => {
    expect(gasEatsTheEdge(1, 10)).toBeNull();
  });
  it('blocker when gas exceeds the ratio', () => {
    expect(gasEatsTheEdge(6, 10)).toMatch(/% of edge/);
  });
  it('blocker when edge is zero or negative', () => {
    expect(gasEatsTheEdge(1, 0)).toMatch(/no edge/);
    expect(gasEatsTheEdge(1, -5)).toMatch(/no edge/);
  });
  it('custom ratio threshold is honored', () => {
    expect(gasEatsTheEdge(3, 10, 0.2)).toMatch(/% of edge/);
    expect(gasEatsTheEdge(3, 10, 0.4)).toBeNull();
  });
});

describe('isGasSpike', () => {
  it('detects a 3x jump against baseline', () => {
    const base = mkFee({ baseFeePerGas: 1_000_000_000n });
    const now = mkFee({ baseFeePerGas: 3_000_000_000n });
    expect(isGasSpike(now, base)).toBe(true);
  });
  it('no spike at equal base fees', () => {
    const base = mkFee({ baseFeePerGas: 1_000_000_000n });
    expect(isGasSpike(base, base)).toBe(false);
  });
  it('returns false when baseline is zero to avoid div/0', () => {
    const zero = mkFee({ baseFeePerGas: 0n });
    const hot = mkFee({ baseFeePerGas: 1_000_000_000n });
    expect(isGasSpike(hot, zero)).toBe(false);
  });
  it('custom ratio threshold is honored', () => {
    const base = mkFee({ baseFeePerGas: 1_000_000_000n });
    const warm = mkFee({ baseFeePerGas: 1_500_000_000n });
    expect(isGasSpike(warm, base, 2.0)).toBe(false);
    expect(isGasSpike(warm, base, 1.4)).toBe(true);
  });
});

describe('ViemGasOracle', () => {
  function fakeClient(fee: {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    baseFeePerGas: bigint;
  }) {
    return {
      estimateFeesPerGas: async () => ({
        maxFeePerGas: fee.maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      }),
      getBlock: async () => ({ baseFeePerGas: fee.baseFeePerGas }),
    };
  }

  it('returns fee data stitched from the client + injected clock', async () => {
    const oracle = new ViemGasOracle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: fakeClient({
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 100_000_000n,
        baseFeePerGas: 1_900_000_000n,
      }) as any },
      now: () => 42,
    });
    const fee = await oracle.getFeeData('base');
    expect(fee.chain).toBe('base');
    expect(fee.maxFeePerGas).toBe(2_000_000_000n);
    expect(fee.maxPriorityFeePerGas).toBe(100_000_000n);
    expect(fee.baseFeePerGas).toBe(1_900_000_000n);
    expect(fee.observedAt).toBe(42);
  });

  it('throws for chains that have no PublicClient wired', async () => {
    const oracle = new ViemGasOracle({ clients: {} });
    await expect(oracle.getFeeData('ethereum')).rejects.toThrow(/no PublicClient/);
  });

  it('caches fee data within the TTL window and refreshes once it expires', async () => {
    let calls = 0;
    const client = {
      estimateFeesPerGas: async () => {
        calls++;
        return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
      },
      getBlock: async () => ({ baseFeePerGas: 900_000_000n }),
    };
    let now = 1_000;
    const oracle = new ViemGasOracle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: client as any },
      now: () => now,
      cacheTtlMs: 500,
    });
    await oracle.getFeeData('base');
    await oracle.getFeeData('base');
    expect(calls).toBe(1);
    now = 1_600;
    await oracle.getFeeData('base');
    expect(calls).toBe(2);
  });

  it('coalesces concurrent fetches for the same chain (single in-flight RPC)', async () => {
    let calls = 0;
    let resolve!: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });
    const client = {
      estimateFeesPerGas: async () => {
        calls++;
        await gate;
        return { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n };
      },
      getBlock: async () => ({ baseFeePerGas: 0n }),
    };
    const oracle = new ViemGasOracle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: client as any },
      cacheTtlMs: 10_000,
    });
    const p1 = oracle.getFeeData('base');
    const p2 = oracle.getFeeData('base');
    resolve();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it('invalidate() forces a refresh on the next call', async () => {
    let calls = 0;
    const client = {
      estimateFeesPerGas: async () => { calls++; return { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }; },
      getBlock: async () => ({ baseFeePerGas: 0n }),
    };
    const oracle = new ViemGasOracle({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: client as any },
      cacheTtlMs: 10_000,
    });
    await oracle.getFeeData('base');
    await oracle.getFeeData('base');
    expect(calls).toBe(1);
    oracle.invalidate('base');
    await oracle.getFeeData('base');
    expect(calls).toBe(2);
  });
});
