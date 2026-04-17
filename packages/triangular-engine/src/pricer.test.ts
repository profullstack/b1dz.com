import { describe, it, expect, vi } from 'vitest';
import type { Address } from 'viem';
import { priceTriangle } from './pricer.js';

const QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as Address;

/** Build a minimal viem-like client whose `simulateContract` returns the
 *  canned `[amountOut, [], [], gasEstimate]` tuple. */
function clientReturning(amountOut: bigint, gasEstimate: bigint = 350_000n) {
  return {
    simulateContract: vi.fn(async () => ({
      result: [amountOut, [] as bigint[], [] as number[], gasEstimate] as const,
    })),
  };
}

function clientThrowing() {
  return {
    simulateContract: vi.fn(async () => {
      throw new Error('execution reverted: no liquidity');
    }),
  };
}

function fixedGasOracle() {
  return {
    getFeeData: vi.fn(async () => ({
      chain: 'base' as const,
      // 0.001 gwei/gas — Base is cheap.
      maxFeePerGas: 1_000_000n,
      maxPriorityFeePerGas: 100_000n,
      baseFeePerGas: 900_000n,
      observedAt: 0,
    })),
  };
}

describe('priceTriangle', () => {
  it('returns a priced triangle when the quoter yields amountOut > input', async () => {
    // 100 USDC in → 101 USDC out (101_000_000 in USDC 6-decimal base units).
    const client = clientReturning(101_000_000n);
    const res = await priceTriangle({
      triangle: { anchor: 'USDC', midA: 'WETH', midB: 'AERO' },
      chain: 'base',
      client,
      quoter: QUOTER,
      amountInDecimal: '100',
      feeTier: 3000,
      gasOracle: fixedGasOracle(),
      nativeUsd: () => 2500,
    });
    expect(res).not.toBeNull();
    expect(res!.amountInDecimal).toBe('100');
    expect(res!.amountOutDecimal).toBe('101');
    expect(res!.grossEdgeUsd).toBeCloseTo(1, 5);
    expect(res!.gasUsd).toBeGreaterThan(0);
    // net = gross - gas
    expect(res!.expectedNetUsd).toBeCloseTo(1 - res!.gasUsd, 5);
    expect(res!.hops).toHaveLength(3);
    expect(res!.hops[0]).toEqual({ tokenIn: 'USDC', tokenOut: 'WETH', fee: 3000 });
    expect(res!.hops[2]).toEqual({ tokenIn: 'AERO', tokenOut: 'USDC', fee: 3000 });
    expect(res!.path.startsWith('0x')).toBe(true);
    expect(client.simulateContract).toHaveBeenCalledTimes(1);
  });

  it('returns null when the quoter reverts (no-liquidity path)', async () => {
    const res = await priceTriangle({
      triangle: { anchor: 'USDC', midA: 'WETH', midB: 'AERO' },
      chain: 'base',
      client: clientThrowing(),
      quoter: QUOTER,
      amountInDecimal: '100',
      feeTier: 3000,
      gasOracle: fixedGasOracle(),
      nativeUsd: () => 2500,
    });
    expect(res).toBeNull();
  });

  it('returns null when a token is not in the registry', async () => {
    const res = await priceTriangle({
      triangle: { anchor: 'USDC', midA: 'WETH', midB: 'NOT_A_REAL_TOKEN' },
      chain: 'base',
      client: clientReturning(101_000_000n),
      quoter: QUOTER,
      amountInDecimal: '100',
      feeTier: 3000,
      gasOracle: fixedGasOracle(),
      nativeUsd: () => 2500,
    });
    expect(res).toBeNull();
  });

  it('produces negative net when the quoter undercuts input', async () => {
    // 99 USDC out for 100 USDC in.
    const res = await priceTriangle({
      triangle: { anchor: 'USDC', midA: 'WETH', midB: 'AERO' },
      chain: 'base',
      client: clientReturning(99_000_000n),
      quoter: QUOTER,
      amountInDecimal: '100',
      feeTier: 3000,
      gasOracle: fixedGasOracle(),
      nativeUsd: () => 2500,
    });
    expect(res).not.toBeNull();
    expect(res!.grossEdgeUsd).toBeCloseTo(-1, 5);
    expect(res!.expectedNetUsd).toBeLessThan(0);
  });
});
