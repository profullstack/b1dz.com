/**
 * Executor factory — reads env, builds wallet-service deps, returns
 * an executor to register with the v2 pipeline. Returns `null` when
 * the executor isn't armed, so the pipeline just stays in its current
 * mode without wallet gymnastics at boot.
 *
 * Arming requires ALL of:
 *   - V2_MODE=live                       daemon will actually dispatch
 *   - V2_EXECUTOR_UNISWAP_BASE=true      explicit opt-in
 *   - EVM_PRIVATE_KEY                    hot wallet private key
 *   - BASE_RPC_URL                       viem http transport
 *
 * If any are missing we return null. The TradeDaemon then aborts live
 * opportunities with "live mode enabled but no Executor wired" — the
 * intended safe default.
 */

import type { Executor } from '@b1dz/trade-daemon';
import {
  ViemGasOracle,
  base,
  createPublicClient,
  http,
  type PublicClient,
} from '@b1dz/adapters-evm';
import { WalletService } from '@b1dz/wallet-service';
import { DirectEvmWalletProvider } from '@b1dz/wallet-direct';
import { UniswapV3BaseExecutor } from './uniswap-v3-base.js';
import { CexCexExecutor } from './cex-cex.js';

function floatEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function maybeBuildUniswapV3BaseExecutor(): Promise<Executor | null> {
  const executorEnabled = process.env.ARB_EXECUTOR_UNISWAP_BASE ?? process.env.V2_EXECUTOR_UNISWAP_BASE;
  if (executorEnabled !== 'true') return null;
  const mode = (process.env.ARB_MODE ?? process.env.V2_MODE ?? '').toLowerCase();
  if (mode !== 'live') {
    console.warn('[arb] ARB_EXECUTOR_UNISWAP_BASE=true but ARB_MODE!=live — skipping executor registration');
    return null;
  }
  const privateKey = process.env.EVM_PRIVATE_KEY;
  if (!privateKey) {
    console.warn('[arb] ARB_EXECUTOR_UNISWAP_BASE=true but EVM_PRIVATE_KEY missing — skipping');
    return null;
  }
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    console.warn('[arb] ARB_EXECUTOR_UNISWAP_BASE=true but BASE_RPC_URL missing — skipping');
    return null;
  }

  const wallet = new DirectEvmWalletProvider({ privateKey: privateKey as `0x${string}` });
  const address = wallet.getAddress
    ? await wallet.getAddress('base')
    : null;
  if (!address) {
    console.warn('[arb] wallet provider returned no address for base — skipping');
    return null;
  }

  // viem narrows createPublicClient({ chain: base }) to an op-stack-aware
  // client type; WalletService's `clients` map expects the plain
  // PublicClient. Cast back to the generic shape — the runtime is
  // identical.
  const baseClient = createPublicClient({ chain: base, transport: http(rpcUrl) }) as unknown as PublicClient;
  const gasOracle = new ViemGasOracle({ clients: { base: baseClient } });
  const walletService = new WalletService({
    clients: { base: baseClient },
    walletProvider: wallet,
    gasOracle,
  });

  const maxTradeUsd = floatEnv('ARB_MAX_TRADE_USD', floatEnv('V2_MAX_TRADE_USD', 5));
  console.log(
    `[arb] UniswapV3BaseExecutor armed  wallet=${address}  maxTradeUsd=$${maxTradeUsd}`,
  );
  return new UniswapV3BaseExecutor({
    walletService,
    walletAddress: address as `0x${string}`,
    maxTradeUsd,
  });
}

/**
 * CEX↔CEX executor — always buildable (no wallet / RPC deps). Still
 * gated on ARB_MODE=live + ARB_EXECUTOR_CEX_CEX=true so the operator has
 * to explicitly opt in.
 */
export function maybeBuildCexCexExecutor(): Executor | null {
  const enabled = process.env.ARB_EXECUTOR_CEX_CEX ?? process.env.V2_EXECUTOR_CEX_CEX;
  if (enabled !== 'true') return null;
  const mode = (process.env.ARB_MODE ?? process.env.V2_MODE ?? '').toLowerCase();
  if (mode !== 'live') {
    console.warn('[arb] ARB_EXECUTOR_CEX_CEX=true but ARB_MODE!=live — skipping');
    return null;
  }
  const maxTradeUsd = floatEnv('ARB_MAX_TRADE_USD', floatEnv('V2_MAX_TRADE_USD', 5));
  const slippageBps = floatEnv('ARB_CEX_CEX_SLIPPAGE_BPS', 200);
  console.log(`[arb] CexCexExecutor armed  maxTradeUsd=$${maxTradeUsd}  slippageBps=${slippageBps}`);
  return new CexCexExecutor({ maxTradeUsd, slippageBps });
}
