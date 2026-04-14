import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { GasOracle, FeeData } from '@b1dz/adapters-evm';
import type { WalletProvider } from '@b1dz/wallet-provider';
import { WalletService } from './index.js';

const PK = '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;
const FROM: Address = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const TO: Address = '0x2626664c2603336E57B271c5C0b26F421741e481';

function fakeGasOracle(fee: Partial<FeeData> = {}): GasOracle {
  return {
    getFeeData: async () => ({
      chain: 'base',
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      baseFeePerGas: 900_000_000n,
      observedAt: 0,
      ...fee,
    }),
  };
}

/** A wallet provider that delegates signDigest to viem's real
 *  privateKeyToAccount so the resulting tx is a valid signed EIP-1559
 *  payload — callers of this fake get realistic bytes out. */
function viemBackedWalletProvider(): WalletProvider {
  const account = privateKeyToAccount(PK);
  return {
    id: 'fake-evm',
    capabilities() { return ['sign-digest', 'get-address']; },
    supportedChains() { return ['base']; },
    async getAddress() { return account.address; },
    async signDigest(req) {
      return account.sign({ hash: req.digestHex as Hex });
    },
  };
}

function fakeClient(overrides: {
  txCount?: number;
  sendRaw?: (args: unknown) => Promise<Hex>;
  getReceipt?: (args: unknown) => Promise<unknown>;
} = {}) {
  return {
    getTransactionCount: vi.fn(async () => overrides.txCount ?? 0),
    sendRawTransaction: vi.fn(overrides.sendRaw ?? (async () =>
      '0xdeadbeef00000000000000000000000000000000000000000000000000000001' as Hex
    )),
    getTransactionReceipt: vi.fn(overrides.getReceipt ?? (async () => ({
      status: 'success' as const,
      blockNumber: 42n,
      gasUsed: 21_000n,
      effectiveGasPrice: 1_000_000_000n,
    }))),
  };
}

describe('WalletService.execute', () => {
  it('fills on the happy path (build → sign → broadcast → receipt)', async () => {
    const client = fakeClient();
    const svc = new WalletService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: client as any },
      walletProvider: viemBackedWalletProvider(),
      gasOracle: fakeGasOracle(),
      log: () => {},
    });
    const result = await svc.execute({
      chain: 'base', from: FROM, to: TO, data: '0xabcd',
      gasLimit: 150_000n, value: 0n,
    });
    expect(result.status).toBe('filled');
    expect(result.txHash).toBeTruthy();
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.feeData?.maxFeePerGas).toBe(1_000_000_000n);
  });

  it('aborts when preflight returns a blocker string', async () => {
    const client = fakeClient();
    const svc = new WalletService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: client as any },
      walletProvider: viemBackedWalletProvider(),
      gasOracle: fakeGasOracle(),
      preflight: async () => 'insufficient USDC balance',
      log: () => {},
    });
    const result = await svc.execute({
      chain: 'base', from: FROM, to: TO, data: '0x', gasLimit: 100_000n,
    });
    expect(result.status).toBe('aborted');
    expect(result.resolvedReason).toMatch(/insufficient USDC/);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('aborts with status=reverted when the receipt shows a revert', async () => {
    const client = fakeClient({
      getReceipt: async () => ({ status: 'reverted', blockNumber: 1n, gasUsed: 50_000n }),
    });
    const svc = new WalletService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: client as any },
      walletProvider: viemBackedWalletProvider(),
      gasOracle: fakeGasOracle(),
      log: () => {},
    });
    const result = await svc.execute({
      chain: 'base', from: FROM, to: TO, data: '0x', gasLimit: 100_000n,
    });
    expect(result.status).toBe('reverted');
    expect(result.outcome?.kind).toBe('reverted');
  });

  it('aborts when broadcast throws and resyncs the nonce', async () => {
    const client = fakeClient({
      sendRaw: async () => { throw new Error('insufficient funds'); },
    });
    const svc = new WalletService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: client as any },
      walletProvider: viemBackedWalletProvider(),
      gasOracle: fakeGasOracle(),
      log: () => {},
    });
    const result = await svc.execute({
      chain: 'base', from: FROM, to: TO, data: '0x', gasLimit: 100_000n,
    });
    expect(result.status).toBe('aborted');
    expect(result.resolvedReason).toMatch(/broadcast: insufficient funds/);
  });

  it('aborts when the wallet provider lacks signDigest', async () => {
    const noSign: WalletProvider = {
      id: 'no-sign',
      capabilities() { return ['get-address']; },
      supportedChains() { return ['base']; },
      async getAddress() { return FROM; },
    };
    const client = fakeClient();
    const svc = new WalletService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: client as any },
      walletProvider: noSign,
      gasOracle: fakeGasOracle(),
      log: () => {},
    });
    const result = await svc.execute({
      chain: 'base', from: FROM, to: TO, data: '0x', gasLimit: 100_000n,
    });
    expect(result.status).toBe('aborted');
    expect(result.resolvedReason).toMatch(/signDigest/);
  });

  it('aborts when no client is wired for the chain', async () => {
    const svc = new WalletService({
      clients: {},
      walletProvider: viemBackedWalletProvider(),
      gasOracle: fakeGasOracle(),
      log: () => {},
    });
    const result = await svc.execute({
      chain: 'base', from: FROM, to: TO, data: '0x', gasLimit: 100_000n,
    });
    expect(result.status).toBe('aborted');
    expect(result.resolvedReason).toMatch(/no PublicClient/);
  });

  it('bubbles non-transient errors from the gas oracle as aborts', async () => {
    const client = fakeClient();
    const svc = new WalletService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: client as any },
      walletProvider: viemBackedWalletProvider(),
      gasOracle: { getFeeData: async () => { throw new Error('RPC down'); } },
      log: () => {},
    });
    const result = await svc.execute({
      chain: 'base', from: FROM, to: TO, data: '0x', gasLimit: 100_000n,
    });
    expect(result.status).toBe('aborted');
    expect(result.resolvedReason).toMatch(/gas oracle: RPC down/);
  });

  it('signs with an incrementing nonce across sequential executions', async () => {
    const client = fakeClient({ txCount: 5 });
    const svc = new WalletService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: client as any },
      walletProvider: viemBackedWalletProvider(),
      gasOracle: fakeGasOracle(),
      log: () => {},
    });
    await svc.execute({ chain: 'base', from: FROM, to: TO, data: '0x', gasLimit: 100_000n });
    await svc.execute({ chain: 'base', from: FROM, to: TO, data: '0x', gasLimit: 100_000n });
    // getTransactionCount is only called once on first allocation;
    // subsequent calls use the cached increment.
    expect(client.getTransactionCount).toHaveBeenCalledTimes(1);
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(2);
  });
});
