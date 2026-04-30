#!/usr/bin/env tsx
/**
 * One-off approval: USDC (on Base) → Uniswap SwapRouter02.
 *
 * Required before DEX_TRADE_EXECUTION=true on the Base/Uniswap leg —
 * otherwise every exactInputSingle reverts on the first token transfer
 * and burns gas.
 *
 * Env used (same as the daemon):
 *   EVM_PRIVATE_KEY  hot wallet private key (0x-prefixed)
 *   BASE_RPC_URL     viem http transport
 *
 * Usage (from repo root):
 *   pnpm --filter @b1dz/daemon exec tsx --env-file=../../.env scripts/approve-base-usdc-for-uniswap.ts             # dry-run
 *   pnpm --filter @b1dz/daemon exec tsx --env-file=../../.env scripts/approve-base-usdc-for-uniswap.ts --execute   # submit
 *   pnpm --filter @b1dz/daemon exec tsx --env-file=../../.env scripts/approve-base-usdc-for-uniswap.ts --unlimited # uint256 max
 *
 * Default approval amount: 1000 USDC (unit=1e6). Use --unlimited if you
 * plan to run many trades and don't want to re-approve.
 */

import {
  UNISWAP_V3_FEE_TIERS, // re-exported so adapters-evm barrel is confirmed loaded
  ViemGasOracle,
  base,
  buildApprovalTx,
  checkApproval,
  createPublicClient,
  http,
  tokenFor,
  type Address,
  type PublicClient,
} from '@b1dz/adapters-evm';
import { WalletService } from '@b1dz/wallet-service';
import { DirectEvmWalletProvider } from '@b1dz/wallet-direct';
import { loadUserConfig, applyEnvOverlay } from '../src/user-config.js';

void UNISWAP_V3_FEE_TIERS;

const SWAP_ROUTER_02_BASE = '0x2626664c2603336E57B271c5C0b26F421741e481' as Address;

async function main() {
  const args = new Set(process.argv.slice(2));
  const execute = args.has('--execute');
  const unlimited = args.has('--unlimited');

  // If EVM_PRIVATE_KEY is not in env, try loading it from user_settings
  // (same decryption path the daemon uses). Requires USER_ID env var.
  if (!process.env.EVM_PRIVATE_KEY) {
    const userId = process.env.USER_ID;
    if (!userId) throw new Error('EVM_PRIVATE_KEY missing and USER_ID not set — cannot load from user_settings');
    const cfg = await loadUserConfig(userId);
    await applyEnvOverlay(cfg, async () => {
      await runApproval(execute, unlimited);
    });
    return;
  }

  await runApproval(execute, unlimited);
}

async function runApproval(execute: boolean, unlimited: boolean) {
  const privateKey = process.env.EVM_PRIVATE_KEY;
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!privateKey) throw new Error('EVM_PRIVATE_KEY missing');
  if (!rpcUrl) throw new Error('BASE_RPC_URL missing');

  const wallet = new DirectEvmWalletProvider({ privateKey: privateKey as `0x${string}` });
  const walletAddress = (await wallet.getAddress('base')) as Address;

  const usdc = tokenFor('base', 'USDC');
  if (!usdc) throw new Error('base USDC missing from token registry');

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) }) as unknown as PublicClient;

  // 1000 USDC (6 decimals). A deliberate middle ground — more than any
  // single DEX_TRADE_MAX_USD will spend, but not unlimited.
  const requiredUnits = 1_000n * 10n ** 6n;

  const need = await checkApproval({
    client,
    token: usdc.address as Address,
    owner: walletAddress,
    spender: SWAP_ROUTER_02_BASE,
    required: requiredUnits,
    mode: unlimited ? 'unlimited' : 'exact',
  });

  console.log('wallet       :', walletAddress);
  console.log('token (USDC) :', usdc.address);
  console.log('spender      :', SWAP_ROUTER_02_BASE, '(SwapRouter02, Base)');
  console.log('current      :', fmtUsdc(need.current));
  console.log('required     :', fmtUsdc(need.required));
  console.log('would approve:', unlimited ? 'unlimited (uint256 max)' : fmtUsdc(need.approvalAmount));
  console.log('needed?      :', need.needed);

  if (!need.needed && !unlimited) {
    console.log('\nallowance already sufficient — nothing to do.');
    return;
  }

  if (!execute) {
    console.log('\ndry-run. re-run with --execute to submit the approval tx.');
    return;
  }

  const approvalTx = buildApprovalTx(need);
  const gasOracle = new ViemGasOracle({ clients: { base: client } });
  const walletService = new WalletService({
    clients: { base: client },
    walletProvider: wallet,
    gasOracle,
  });

  console.log('\nsubmitting approve()...');
  const result = await walletService.execute({
    chain: 'base',
    from: walletAddress,
    to: approvalTx.to,
    data: approvalTx.data,
    value: approvalTx.value,
    gasLimit: approvalTx.gasLimit,
  });
  console.log('status      :', result.status);
  console.log('txHash      :', result.txHash ?? '(none)');
  console.log('resolvedWhy :', result.resolvedReason);
}

function fmtUsdc(units: bigint): string {
  const whole = units / 10n ** 6n;
  const frac = units % 10n ** 6n;
  return `${whole.toString()}.${frac.toString().padStart(6, '0')} USDC (${units} base-units)`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
