/**
 * Executor factory — reads env, builds wallet-service deps, returns
 * an executor to register with the v2 pipeline. Returns `null` when
 * the executor isn't armed, so the pipeline just stays in its current
 * mode without wallet gymnastics at boot.
 *
 * Arming requires:
 *   - ARB_MODE/V2_MODE=live              daemon will actually dispatch
 *   - no explicit *_EXECUTOR_*=false      operator opt-out
 *   - wallet/RPC env for DEX executors    hot wallet + transport
 *
 * CEX↔CEX is auto-armed in live mode because it has no extra wallet deps
 * and still enforces maxTradeUsd + per-leg balance checks. DEX executors
 * auto-arm only when their credentials are present. Operators can opt out
 * with ARB_EXECUTOR_CEX_CEX=false or ARB_EXECUTOR_UNISWAP_BASE=false.
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
import { AggregatorBaseExecutor } from './aggregator-base.js';

function floatEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envFlagDisabled(...keys: string[]): boolean {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw != null && raw.trim().toLowerCase() === 'false') return true;
  }
  return false;
}

function envFlagExplicitlyEnabled(...keys: string[]): boolean {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw != null && raw.trim().toLowerCase() === 'true') return true;
  }
  return false;
}

export async function maybeBuildUniswapV3BaseExecutor(): Promise<Executor | null> {
  const explicit = envFlagExplicitlyEnabled('ARB_EXECUTOR_UNISWAP_BASE', 'V2_EXECUTOR_UNISWAP_BASE');
  if (envFlagDisabled('ARB_EXECUTOR_UNISWAP_BASE', 'V2_EXECUTOR_UNISWAP_BASE')) return null;
  const mode = (process.env.ARB_MODE ?? process.env.V2_MODE ?? '').toLowerCase();
  if (mode !== 'live') {
    if (explicit) console.warn('[arb] ARB_EXECUTOR_UNISWAP_BASE=true but ARB_MODE!=live — skipping executor registration');
    return null;
  }
  const privateKey = process.env.EVM_PRIVATE_KEY;
  if (!privateKey) {
    if (explicit) console.warn('[arb] ARB_EXECUTOR_UNISWAP_BASE=true but EVM_PRIVATE_KEY missing — skipping');
    return null;
  }
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    if (explicit) console.warn('[arb] ARB_EXECUTOR_UNISWAP_BASE=true but BASE_RPC_URL missing — skipping');
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
 * CEX↔CEX executor — auto-armed in live mode (no wallet / RPC deps).
 * Operators can opt out with ARB_EXECUTOR_CEX_CEX=false. Legacy
 * ARB_EXECUTOR_CEX_CEX=true / V2_EXECUTOR_CEX_CEX=true still work, but
 * are no longer required.
 */
export function maybeBuildCexCexExecutor(): Executor | null {
  if (envFlagDisabled('ARB_EXECUTOR_CEX_CEX', 'V2_EXECUTOR_CEX_CEX')) return null;
  const mode = (process.env.ARB_MODE ?? process.env.V2_MODE ?? '').toLowerCase();
  if (mode !== 'live') {
    if (envFlagExplicitlyEnabled('ARB_EXECUTOR_CEX_CEX', 'V2_EXECUTOR_CEX_CEX')) {
      console.warn('[arb] ARB_EXECUTOR_CEX_CEX=true but ARB_MODE!=live — skipping');
    }
    return null;
  }
  const maxTradeUsd = floatEnv('ARB_MAX_TRADE_USD', floatEnv('V2_MAX_TRADE_USD', 5));
  const slippageBps = floatEnv('ARB_CEX_CEX_SLIPPAGE_BPS', 200);
  console.log(`[arb] CexCexExecutor armed  maxTradeUsd=$${maxTradeUsd}  slippageBps=${slippageBps}`);
  return new CexCexExecutor({ maxTradeUsd, slippageBps });
}

/**
 * DEX aggregator executor (0x allowance-holder + 1inch swap API).
 * Auto-arms in live mode when EVM_PRIVATE_KEY + BASE_RPC_URL + at least one
 * of ZEROX_API_KEY / ONEINCH_API_KEY are present. Opt out with
 * ARB_EXECUTOR_AGGREGATOR=false.
 */
export async function maybeBuildAggregatorBaseExecutor(): Promise<Executor | null> {
  if (envFlagDisabled('ARB_EXECUTOR_AGGREGATOR')) return null;
  const mode = (process.env.ARB_MODE ?? process.env.V2_MODE ?? '').toLowerCase();
  if (mode !== 'live') return null;

  const privateKey = process.env.EVM_PRIVATE_KEY;
  if (!privateKey) return null;
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) return null;

  const zeroxApiKey = process.env.ZEROX_API_KEY || undefined;
  const oneinchApiKey = process.env.ONEINCH_API_KEY || undefined;
  if (!zeroxApiKey && !oneinchApiKey) return null;

  const wallet = new DirectEvmWalletProvider({ privateKey: privateKey as `0x${string}` });
  const address = wallet.getAddress ? await wallet.getAddress('base') : null;
  if (!address) {
    console.warn('[arb] AggregatorBaseExecutor: wallet returned no address for base — skipping');
    return null;
  }

  const baseClient = createPublicClient({ chain: base, transport: http(rpcUrl) }) as unknown as PublicClient;
  const gasOracle = new ViemGasOracle({ clients: { base: baseClient } });
  const walletService = new WalletService({
    clients: { base: baseClient },
    walletProvider: wallet,
    gasOracle,
  });

  const maxTradeUsd = floatEnv('ARB_MAX_TRADE_USD', floatEnv('V2_MAX_TRADE_USD', 5));
  const venues = [zeroxApiKey && '0x', oneinchApiKey && '1inch'].filter(Boolean).join('+');
  console.log(`[arb] AggregatorBaseExecutor armed  venues=${venues}  wallet=${address}  maxTradeUsd=$${maxTradeUsd}`);
  return new AggregatorBaseExecutor({
    walletService,
    walletAddress: address as `0x${string}`,
    publicClient: baseClient,
    maxTradeUsd,
    zeroxApiKey,
    oneinchApiKey,
  });
}
