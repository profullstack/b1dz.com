import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address } from 'viem';
import {
  APPROVAL_GAS_LIMIT,
  ERC20_APPROVAL_ABI,
  UINT256_MAX,
  approvalCostKillsEdge,
  buildApprovalTx,
  checkApproval,
  readAllowance,
  safeApproveCalls,
  type ApprovalNeed,
} from './approvals.js';

const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base USDC
const UNIVERSAL_ROUTER: Address = '0x2626664c2603336E57B271c5C0b26F421741e481';
const OWNER: Address = '0x1234567890aBCdEF1234567890abcdef12345678';

function fakeClient(currentAllowance: bigint): Pick<import('viem').PublicClient, 'readContract'> {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract: (async () => currentAllowance) as any,
  };
}

describe('readAllowance', () => {
  it('passes the right args to the client', async () => {
    const value = await readAllowance({
      client: fakeClient(42n),
      token: USDC,
      owner: OWNER,
      spender: UNIVERSAL_ROUTER,
    });
    expect(value).toBe(42n);
  });
});

describe('checkApproval', () => {
  it('flags needed=true when current < required', async () => {
    const need = await checkApproval({
      client: fakeClient(50n),
      token: USDC,
      owner: OWNER,
      spender: UNIVERSAL_ROUTER,
      required: 100n,
      mode: 'exact',
    });
    expect(need.needed).toBe(true);
    expect(need.current).toBe(50n);
    expect(need.required).toBe(100n);
    expect(need.approvalAmount).toBe(100n);
  });

  it('flags needed=false when current >= required', async () => {
    const need = await checkApproval({
      client: fakeClient(200n),
      token: USDC,
      owner: OWNER,
      spender: UNIVERSAL_ROUTER,
      required: 100n,
      mode: 'exact',
    });
    expect(need.needed).toBe(false);
  });

  it('unlimited mode sets approvalAmount to uint256 max', async () => {
    const need = await checkApproval({
      client: fakeClient(0n),
      token: USDC,
      owner: OWNER,
      spender: UNIVERSAL_ROUTER,
      required: 100n,
      mode: 'unlimited',
    });
    expect(need.approvalAmount).toBe(UINT256_MAX);
  });
});

describe('buildApprovalTx', () => {
  function mkNeed(overrides: Partial<ApprovalNeed> = {}): ApprovalNeed {
    return {
      needed: true,
      current: 0n,
      required: 1_000_000n,
      approvalAmount: 1_000_000n,
      token: USDC,
      spender: UNIVERSAL_ROUTER,
      mode: 'exact',
      ...overrides,
    };
  }

  it('produces calldata that decodes back to approve(spender, amount)', () => {
    const tx = buildApprovalTx(mkNeed());
    expect(tx.to).toBe(USDC);
    expect(tx.value).toBe(0n);
    expect(tx.gasLimit).toBe(APPROVAL_GAS_LIMIT);
    const decoded = decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: tx.data });
    expect(decoded.functionName).toBe('approve');
    expect(decoded.args).toEqual([UNIVERSAL_ROUTER, 1_000_000n]);
  });

  it('encodes unlimited amount as uint256 max', () => {
    const tx = buildApprovalTx(mkNeed({ approvalAmount: UINT256_MAX, mode: 'unlimited' }));
    const decoded = decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: tx.data });
    expect(decoded.args?.[1]).toBe(UINT256_MAX);
  });
});

describe('approvalCostKillsEdge', () => {
  it('null when cost is a tiny fraction of edge', () => {
    expect(approvalCostKillsEdge(0.5, 10)).toBeNull();
  });
  it('blocker when cost exceeds the ratio', () => {
    expect(approvalCostKillsEdge(6, 10)).toMatch(/approval cost/);
  });
  it('null when approval cost is zero', () => {
    expect(approvalCostKillsEdge(0, 10)).toBeNull();
  });
  it('blocker when edge is zero', () => {
    expect(approvalCostKillsEdge(1, 0)).toMatch(/no edge/);
  });
  it('custom ratio threshold works', () => {
    expect(approvalCostKillsEdge(3, 10, 0.2)).toMatch(/approval cost/);
    expect(approvalCostKillsEdge(3, 10, 0.4)).toBeNull();
  });
});

describe('safeApproveCalls', () => {
  function mkNeed(overrides: Partial<ApprovalNeed> = {}): ApprovalNeed {
    return {
      needed: true,
      current: 0n,
      required: 1_000_000n,
      approvalAmount: 1_000_000n,
      token: USDC,
      spender: UNIVERSAL_ROUTER,
      mode: 'exact',
      ...overrides,
    };
  }

  it('returns empty when no approval is needed', () => {
    expect(safeApproveCalls(mkNeed({ needed: false }))).toEqual([]);
  });

  it('single call when current allowance is already zero', () => {
    const calls = safeApproveCalls(mkNeed({ current: 0n }));
    expect(calls).toHaveLength(1);
  });

  it('two calls when current is non-zero (USDT pattern)', () => {
    const calls = safeApproveCalls(mkNeed({ current: 500n }));
    expect(calls).toHaveLength(2);
    const first = decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: calls[0]!.data });
    const second = decodeFunctionData({ abi: ERC20_APPROVAL_ABI, data: calls[1]!.data });
    expect(first.args?.[1]).toBe(0n);
    expect(second.args?.[1]).toBe(1_000_000n);
  });
});
