import { describe, expect, it } from 'vitest';
import {
  parseTransaction,
  recoverTransactionAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  assembleSignedTx,
  buildUnsignedTx,
  digestForSigning,
  toSerializable,
} from './tx-builder.js';
import type { FeeData } from './gas.js';

const PK = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;
const ADDR: Address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const SPENDER: Address = '0x2626664c2603336E57B271c5C0b26F421741e481'; // Uniswap router on Base

function mkFee(overrides: Partial<FeeData> = {}): FeeData {
  return {
    chain: 'base',
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    baseFeePerGas: 1_900_000_000n,
    observedAt: 0,
    ...overrides,
  };
}

describe('buildUnsignedTx', () => {
  it('fills chainId from the EVM_CHAIN_IDS table', () => {
    const tx = buildUnsignedTx({
      chain: 'base',
      from: ADDR,
      to: SPENDER,
      data: '0x',
      gasLimit: 100_000n,
      nonce: 0,
      feeData: mkFee(),
    });
    expect(tx.chainId).toBe(8453);
  });

  it('defaults value to 0', () => {
    const tx = buildUnsignedTx({
      chain: 'base', from: ADDR, to: SPENDER, data: '0x',
      gasLimit: 100_000n, nonce: 0, feeData: mkFee(),
    });
    expect(tx.value).toBe(0n);
  });

  it('throws when fee data is for a different chain', () => {
    expect(() => buildUnsignedTx({
      chain: 'base', from: ADDR, to: SPENDER, data: '0x',
      gasLimit: 100_000n, nonce: 0,
      feeData: mkFee({ chain: 'ethereum' }),
    })).toThrow(/fee data is for/);
  });

  it('rejects non-positive gasLimit', () => {
    expect(() => buildUnsignedTx({
      chain: 'base', from: ADDR, to: SPENDER, data: '0x',
      gasLimit: 0n, nonce: 0, feeData: mkFee(),
    })).toThrow(/gasLimit/);
  });

  it('rejects negative / non-integer nonce', () => {
    expect(() => buildUnsignedTx({
      chain: 'base', from: ADDR, to: SPENDER, data: '0x',
      gasLimit: 100_000n, nonce: -1, feeData: mkFee(),
    })).toThrow(/nonce/);
    expect(() => buildUnsignedTx({
      chain: 'base', from: ADDR, to: SPENDER, data: '0x',
      gasLimit: 100_000n, nonce: 1.5, feeData: mkFee(),
    })).toThrow(/nonce/);
  });
});

describe('digestForSigning + assembleSignedTx round-trip', () => {
  it('signed tx deserializes to the same fields we built', async () => {
    const account = privateKeyToAccount(PK);
    const unsigned = buildUnsignedTx({
      chain: 'base', from: account.address, to: SPENDER, data: '0xabcd',
      gasLimit: 150_000n, nonce: 7, value: 12345n,
      feeData: mkFee({ maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 500_000_000n }),
    });
    const digest = digestForSigning(unsigned);
    const sig = await account.sign({ hash: digest });
    const signed = assembleSignedTx(unsigned, sig);

    const parsed = parseTransaction(signed);
    expect(parsed.type).toBe('eip1559');
    expect(parsed.chainId).toBe(8453);
    expect(parsed.to?.toLowerCase()).toBe(SPENDER.toLowerCase());
    expect(parsed.data).toBe('0xabcd');
    expect(parsed.value).toBe(12345n);
    expect(parsed.gas).toBe(150_000n);
    expect(parsed.nonce).toBe(7);
    expect(parsed.maxFeePerGas).toBe(3_000_000_000n);
    expect(parsed.maxPriorityFeePerGas).toBe(500_000_000n);
  });

  it('signature recovers back to the signer address', async () => {
    const account = privateKeyToAccount(PK);
    const unsigned = buildUnsignedTx({
      chain: 'ethereum', from: account.address, to: SPENDER, data: '0x',
      gasLimit: 21_000n, nonce: 0, feeData: mkFee({ chain: 'ethereum' }),
    });
    const digest = digestForSigning(unsigned);
    const sig = await account.sign({ hash: digest });
    const signed = assembleSignedTx(unsigned, sig);

    // viem narrows `serializedTransaction` to a branded `0x02${string}` /
    // `0x01${string}` union; our builder returns plain `Hex`. Cast on
    // the consumer side since the runtime bytes ARE type-2 EIP-1559.
    const recovered = await recoverTransactionAddress({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serializedTransaction: signed as any,
    });
    expect(recovered.toLowerCase()).toBe(ADDR.toLowerCase());
  });
});

describe('toSerializable', () => {
  it('emits the EIP-1559 discriminant', () => {
    const s = toSerializable(buildUnsignedTx({
      chain: 'base', from: ADDR, to: SPENDER, data: '0x',
      gasLimit: 100_000n, nonce: 0, feeData: mkFee(),
    }));
    expect(s.type).toBe('eip1559');
  });
});
