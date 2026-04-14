import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  EvmWalletBalanceSource,
  InventoryLedger,
  type BalanceSource,
  type InventoryKey,
} from './index.js';

function mkStaticSource(values: Record<string, string>): BalanceSource {
  return {
    supports: (k) => `${k.venue}/${k.chain}/${k.token}` in values,
    fetchAvailable: async (k) => values[`${k.venue}/${k.chain}/${k.token}`]!,
  };
}

const KEY_USDC: InventoryKey = { venue: 'hot-evm', chain: 'base', token: 'USDC' };
const KEY_ETH: InventoryKey = { venue: 'hot-evm', chain: 'base', token: 'ETH' };

describe('InventoryLedger', () => {
  it('refresh populates an entry from the matching source', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '1500000000' }); // 1500 USDC (6 dp)
    const ledger = new InventoryLedger({ sources: [src] });
    const entry = await ledger.refresh(KEY_USDC);
    expect(entry.available).toBe('1500000000');
    expect(entry.reserved).toBe('0');
    expect(entry.pendingTx).toBe('0');
  });

  it('throws on refresh when no source supports the key', async () => {
    const ledger = new InventoryLedger({ sources: [] });
    await expect(ledger.refresh(KEY_USDC)).rejects.toThrow(/no balance source/);
  });

  it('canAfford returns null when amount fits in (available - reserved - pending)', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '1000000000' });
    const ledger = new InventoryLedger({ sources: [src] });
    await ledger.refresh(KEY_USDC);
    expect(ledger.canAfford(KEY_USDC, '500000000')).toBeNull();
  });

  it('canAfford returns a blocker when the amount exceeds free balance', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '1000000' });
    const ledger = new InventoryLedger({ sources: [src] });
    await ledger.refresh(KEY_USDC);
    const block = ledger.canAfford(KEY_USDC, '5000000');
    expect(block).toMatch(/need 5000000/);
  });

  it('canAfford blocks when the key has never been refreshed', () => {
    const ledger = new InventoryLedger({ sources: [] });
    expect(ledger.canAfford(KEY_USDC, '1')).toMatch(/no entry/);
  });

  it('reserve atomically moves amount from available to reserved', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '1000000000' });
    const ledger = new InventoryLedger({ sources: [src] });
    await ledger.refresh(KEY_USDC);
    const entry = ledger.reserve({ ...KEY_USDC, amount: '300000000' });
    expect(entry.reserved).toBe('300000000');
    expect(ledger.canAfford(KEY_USDC, '700000000')).toBeNull();
    expect(ledger.canAfford(KEY_USDC, '700000001')).toMatch(/need/);
  });

  it('reserve throws when insufficient', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '100' });
    const ledger = new InventoryLedger({ sources: [src] });
    await ledger.refresh(KEY_USDC);
    expect(() => ledger.reserve({ ...KEY_USDC, amount: '200' })).toThrow(/need 200/);
  });

  it('release undoes a reserve', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '1000' });
    const ledger = new InventoryLedger({ sources: [src] });
    await ledger.refresh(KEY_USDC);
    ledger.reserve({ ...KEY_USDC, amount: '400' });
    const entry = ledger.release({ ...KEY_USDC, amount: '400' });
    expect(entry.reserved).toBe('0');
  });

  it('markPending moves amount from reserved to pendingTx', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '1000' });
    const ledger = new InventoryLedger({ sources: [src] });
    await ledger.refresh(KEY_USDC);
    ledger.reserve({ ...KEY_USDC, amount: '500' });
    const entry = ledger.markPending({ ...KEY_USDC, amount: '500' });
    expect(entry.reserved).toBe('0');
    expect(entry.pendingTx).toBe('500');
  });

  it('settle subtracts the real consumed amount from available and clears pending', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '1000' });
    const ledger = new InventoryLedger({ sources: [src] });
    await ledger.refresh(KEY_USDC);
    ledger.reserve({ ...KEY_USDC, amount: '400' });
    ledger.markPending({ ...KEY_USDC, amount: '400' });
    const entry = ledger.settle({ ...KEY_USDC, amount: '400', consumedFromAvailable: '405' }); // 5 extra for slippage
    expect(entry.pendingTx).toBe('0');
    expect(entry.available).toBe('595');
  });

  it('refresh preserves reserved + pendingTx book-keeping across re-reads', async () => {
    const values: Record<string, string> = { 'hot-evm/base/USDC': '1000' };
    const src = mkStaticSource(values);
    const ledger = new InventoryLedger({ sources: [src] });
    await ledger.refresh(KEY_USDC);
    ledger.reserve({ ...KEY_USDC, amount: '200' });
    // balance ticks up on chain (e.g. we received funds)
    values['hot-evm/base/USDC'] = '1500';
    const entry = await ledger.refresh(KEY_USDC);
    expect(entry.available).toBe('1500');
    expect(entry.reserved).toBe('200'); // preserved
  });

  it('rejects decimal strings to catch unit-conversion mistakes', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '1000' });
    const ledger = new InventoryLedger({ sources: [src] });
    await ledger.refresh(KEY_USDC);
    expect(() => ledger.reserve({ ...KEY_USDC, amount: '1.5' })).toThrow(/base-unit integer/);
  });

  it('snapshot returns every tracked entry', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '100', 'hot-evm/base/ETH': '5000000000000000000' });
    const ledger = new InventoryLedger({ sources: [src] });
    await ledger.refresh(KEY_USDC);
    await ledger.refresh(KEY_ETH);
    expect(ledger.snapshot()).toHaveLength(2);
  });

  it('populates usdReference via the resolver', async () => {
    const src = mkStaticSource({ 'hot-evm/base/USDC': '1500000000' });
    const ledger = new InventoryLedger({
      sources: [src],
      usdReference: (_, amount) => Number.parseInt(amount) / 1e6,
    });
    const entry = await ledger.refresh(KEY_USDC);
    expect(entry.usdReference).toBe(1500);
  });
});

describe('EvmWalletBalanceSource', () => {
  const WALLET = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' as Address;
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;

  function mkClient(native: bigint, erc20: bigint) {
    return {
      getBalance: async () => native,
      readContract: async () => erc20,
    };
  }

  it('reads native balance via getBalance', async () => {
    const source = new EvmWalletBalanceSource({
      venue: 'hot-evm',
      wallet: WALLET,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: mkClient(1_000_000_000_000_000_000n, 0n) as any },
      tokens: { base: { ETH: { address: USDC, isNative: true } } },
    });
    const balance = await source.fetchAvailable({ venue: 'hot-evm', chain: 'base', token: 'ETH' });
    expect(balance).toBe('1000000000000000000');
  });

  it('reads ERC20 balance via balanceOf', async () => {
    const source = new EvmWalletBalanceSource({
      venue: 'hot-evm',
      wallet: WALLET,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clients: { base: mkClient(0n, 1_500_000_000n) as any },
      tokens: { base: { USDC: { address: USDC, isNative: false } } },
    });
    const balance = await source.fetchAvailable({ venue: 'hot-evm', chain: 'base', token: 'USDC' });
    expect(balance).toBe('1500000000');
  });

  it('supports() gates by venue, chain, and token', () => {
    const source = new EvmWalletBalanceSource({
      venue: 'hot-evm',
      wallet: WALLET,
      clients: {},
      tokens: { base: { USDC: { address: USDC, isNative: false } } },
    });
    expect(source.supports({ venue: 'hot-evm', chain: 'base', token: 'USDC' })).toBe(true);
    expect(source.supports({ venue: 'other', chain: 'base', token: 'USDC' })).toBe(false);
    expect(source.supports({ venue: 'hot-evm', chain: 'ethereum', token: 'USDC' })).toBe(false);
    expect(source.supports({ venue: 'hot-evm', chain: 'base', token: 'DAI' })).toBe(false);
  });

  it('throws when no client is wired for the requested chain', async () => {
    const source = new EvmWalletBalanceSource({
      venue: 'hot-evm',
      wallet: WALLET,
      clients: {},
      tokens: { base: { USDC: { address: USDC, isNative: false } } },
    });
    await expect(
      source.fetchAvailable({ venue: 'hot-evm', chain: 'base', token: 'USDC' }),
    ).rejects.toThrow(/no client for base/);
  });
});
