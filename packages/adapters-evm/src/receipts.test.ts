import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import {
  classifyReceipt,
  describeOutcome,
  outcomeToStatus,
  trackReceipt,
  type ReceiptOutcome,
} from './receipts.js';

const HASH: Hex = '0xdeadbeef00000000000000000000000000000000000000000000000000000001';

describe('classifyReceipt', () => {
  it('marks status=success / 1 / 0x1 as kind="success"', () => {
    for (const status of ['success', 1, '0x1'] as const) {
      const out = classifyReceipt({
        status, blockNumber: 10n, gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n,
      });
      expect(out.kind).toBe('success');
    }
  });

  it('marks status=reverted / 0 / 0x0 as kind="reverted"', () => {
    for (const status of ['reverted', 0, '0x0'] as const) {
      const out = classifyReceipt({ status, blockNumber: 11n, gasUsed: 50_000n });
      expect(out.kind).toBe('reverted');
    }
  });

  it('defaults effectiveGasPrice to 0 when the receipt omits it', () => {
    const out = classifyReceipt({ status: 'success', blockNumber: 1n, gasUsed: 1n });
    if (out.kind !== 'success') throw new Error('expected success');
    expect(out.effectiveGasPrice).toBe(0n);
  });
});

describe('trackReceipt', () => {
  it('returns success immediately when the first poll resolves', async () => {
    const client = {
      getTransactionReceipt: async () => ({
        status: 'success' as const, blockNumber: 5n, gasUsed: 42_000n,
        effectiveGasPrice: 1_000_000_000n,
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await trackReceipt({ client: client as any, txHash: HASH, sleep: async () => {} });
    expect(out.kind).toBe('success');
  });

  it('keeps polling when the client throws "ReceiptNotFound" until a receipt arrives', async () => {
    let calls = 0;
    const client = {
      getTransactionReceipt: async () => {
        calls++;
        if (calls < 3) {
          const err = new Error('Transaction receipt could not be found');
          err.name = 'TransactionReceiptNotFoundError';
          throw err;
        }
        return { status: 'success' as const, blockNumber: 7n, gasUsed: 50_000n };
      },
    };
    const out = await trackReceipt({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any, txHash: HASH,
      sleep: async () => {}, now: () => 0,
    });
    expect(out.kind).toBe('success');
    expect(calls).toBe(3);
  });

  it('times out after the configured window and returns kind="timeout"', async () => {
    let now = 0;
    const client = {
      getTransactionReceipt: async () => {
        const err = new Error('receipt not found');
        err.name = 'TransactionReceiptNotFoundError';
        throw err;
      },
    };
    const out = await trackReceipt({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any, txHash: HASH,
      sleep: async () => { now += 1_000; },
      now: () => now,
      timeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    expect(out.kind).toBe('timeout');
    if (out.kind === 'timeout') expect(out.elapsedMs).toBeGreaterThanOrEqual(3_000);
  });

  it('propagates non-"not found" errors from the client', async () => {
    const client = {
      getTransactionReceipt: async () => { throw new Error('RPC exploded'); },
    };
    await expect(trackReceipt({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any, txHash: HASH, sleep: async () => {},
    })).rejects.toThrow(/RPC exploded/);
  });

  it('classifies a reverted receipt as kind="reverted"', async () => {
    const client = {
      getTransactionReceipt: async () => ({ status: 'reverted' as const, blockNumber: 9n, gasUsed: 60_000n }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await trackReceipt({ client: client as any, txHash: HASH, sleep: async () => {} });
    expect(out.kind).toBe('reverted');
  });
});

describe('outcomeToStatus', () => {
  it('maps to the event-channel terminal status vocabulary', () => {
    const success: ReceiptOutcome = { kind: 'success', blockNumber: 1n, gasUsed: 1n, effectiveGasPrice: 1n };
    const reverted: ReceiptOutcome = { kind: 'reverted', blockNumber: 1n, gasUsed: 1n, reason: null };
    const timeout: ReceiptOutcome = { kind: 'timeout', elapsedMs: 1_000 };
    expect(outcomeToStatus(success)).toBe('filled');
    expect(outcomeToStatus(reverted)).toBe('reverted');
    expect(outcomeToStatus(timeout)).toBe('stuck');
  });
});

describe('describeOutcome', () => {
  it('includes block number for success', () => {
    const s = describeOutcome(HASH, { kind: 'success', blockNumber: 42n, gasUsed: 21_000n, effectiveGasPrice: 0n });
    expect(s).toMatch(/block 42/);
    expect(s).toMatch(/gas=21000/);
  });

  it('notes timeout duration', () => {
    const s = describeOutcome(HASH, { kind: 'timeout', elapsedMs: 120_000 });
    expect(s).toMatch(/stuck after 120000/);
  });

  it('abbreviates the from address when provided', () => {
    const s = describeOutcome(HASH, { kind: 'success', blockNumber: 1n, gasUsed: 1n, effectiveGasPrice: 0n }, '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
    expect(s).toMatch(/0x7E5F/);
    expect(s).toMatch(/5Bdf/);
  });
});
