import { describe, it, expect } from 'vitest';
import { encodePath } from './uniswap-v3-multihop.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const WETH = '0x4200000000000000000000000000000000000006' as const;
const AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as const;

describe('encodePath', () => {
  it('encodes a 3-hop triangle to 66 bytes', () => {
    // USDC → WETH (500) → AERO (3000) → USDC (500)
    const path = encodePath([
      { tokenIn: USDC, tokenOut: WETH, fee: 500 },
      { tokenIn: WETH, tokenOut: AERO, fee: 3000 },
      { tokenIn: AERO, tokenOut: USDC, fee: 500 },
    ]);
    // 3 hops = 4 tokens (incl. start/end) + 3 fees = 4*20 + 3*3 = 89 bytes.
    // Hex string length: "0x" + 89 * 2 = 180.
    expect(path.length).toBe(2 + 89 * 2);
    // Starts with the first token (lowercased by encodePacked).
    expect(path.slice(0, 42).toLowerCase()).toBe(USDC.toLowerCase());
  });

  it('places fee tiers between tokens', () => {
    // Single-hop encoded: tokenIn (20) + fee (3) + tokenOut (20) = 43 bytes.
    const path = encodePath([{ tokenIn: USDC, tokenOut: WETH, fee: 500 }]);
    expect(path.length).toBe(2 + 43 * 2);
    // fee=500 = 0x0001F4 — appears right after tokenIn in the packed hex.
    const feeHex = path.slice(42, 48).toLowerCase();
    expect(feeHex).toBe('0001f4');
  });

  it('rejects empty hops', () => {
    expect(() => encodePath([])).toThrow(/non-empty/);
  });

  it('rejects invalid fee tier', () => {
    expect(() => encodePath([{ tokenIn: USDC, tokenOut: WETH, fee: 123 }])).toThrow(/invalid fee/);
  });

  it('rejects non-contiguous hops', () => {
    // WETH ≠ AERO — hop 2 starts with the wrong token.
    expect(() =>
      encodePath([
        { tokenIn: USDC, tokenOut: WETH, fee: 500 },
        { tokenIn: AERO, tokenOut: USDC, fee: 500 },
      ]),
    ).toThrow(/does not match/);
  });
});
