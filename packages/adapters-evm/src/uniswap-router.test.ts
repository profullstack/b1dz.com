import { describe, it, expect } from 'vitest';
import {
  encodeExactInputSingle,
  minOutFromSlippage,
  UNISWAP_V3_SWAP_GAS_LIMIT,
} from './uniswap-router.js';

const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481' as const; // Base
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const WETH = '0x4200000000000000000000000000000000000006' as const;
const WALLET = '0x000000000000000000000000000000000000dEaD' as const;

describe('encodeExactInputSingle', () => {
  it('produces a call with the router address + non-empty calldata', () => {
    const call = encodeExactInputSingle({
      router: ROUTER,
      tokenIn: USDC,
      tokenOut: WETH,
      fee: 500,
      recipient: WALLET,
      amountIn: 5_000_000n, // 5 USDC at 6 decimals
      amountOutMinimum: 1_200_000_000_000_000n, // ~0.0012 ETH at 18 decimals
    });
    expect(call.to).toBe(ROUTER);
    expect(call.value).toBe(0n);
    expect(call.gasLimit).toBe(UNISWAP_V3_SWAP_GAS_LIMIT);
    expect(call.data.startsWith('0x')).toBe(true);
    // exactInputSingle selector — function signature
    // "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"
    // keccak256 prefix is deterministic; just check calldata encodes all fields.
    expect(call.data.length).toBeGreaterThanOrEqual(2 + 8 + 7 * 64);
  });

  it('rejects invalid fee tiers', () => {
    expect(() => encodeExactInputSingle({
      router: ROUTER, tokenIn: USDC, tokenOut: WETH, fee: 123,
      recipient: WALLET, amountIn: 1n, amountOutMinimum: 0n,
    })).toThrow(/invalid uniswap-v3 fee tier/);
  });

  it('rejects zero amountIn', () => {
    expect(() => encodeExactInputSingle({
      router: ROUTER, tokenIn: USDC, tokenOut: WETH, fee: 500,
      recipient: WALLET, amountIn: 0n, amountOutMinimum: 0n,
    })).toThrow(/amountIn must be > 0/);
  });

  it('encodes the configured value for native-in swaps', () => {
    const call = encodeExactInputSingle({
      router: ROUTER, tokenIn: WETH, tokenOut: USDC, fee: 500,
      recipient: WALLET, amountIn: 10n ** 16n, amountOutMinimum: 0n,
      value: 10n ** 16n,
    });
    expect(call.value).toBe(10n ** 16n);
  });
});

describe('minOutFromSlippage', () => {
  it('applies bps-based discount via integer math', () => {
    // 1e18 wei * (10000-50)/10000 = 0.995 * 1e18 = 995_000_000_000_000_000
    expect(minOutFromSlippage(10n ** 18n, 50)).toBe(995_000_000_000_000_000n);
  });

  it('returns 0 for non-positive input', () => {
    expect(minOutFromSlippage(0n, 50)).toBe(0n);
  });

  it('clamps negative bps to 0 (no slippage allowed = require full quote)', () => {
    expect(minOutFromSlippage(10n ** 18n, -10)).toBe(10n ** 18n);
  });

  it('floors to zero with extreme slippage', () => {
    expect(minOutFromSlippage(10n ** 18n, 10_000)).toBe(0n);
  });
});
