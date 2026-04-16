export { ZeroExAdapter, type ZeroExAdapterOptions } from './zeroex.js';
export { OneInchAdapter, type OneInchAdapterOptions } from './oneinch.js';
export {
  UniswapV3Adapter,
  UNISWAP_V3_FEE_TIERS,
  type UniswapV3AdapterOptions,
  type UniswapV3FeeTier,
} from './uniswap-v3.js';
export {
  TOKENS,
  EVM_CHAIN_IDS,
  NATIVE_ASSET_SENTINEL,
  tokenFor,
  isEvmChain,
  toBaseUnits,
  fromBaseUnits,
  type EvmChain,
  type TokenInfo,
} from './tokens.js';
export {
  ViemGasOracle,
  estimateTxCostUsd,
  isFeeDataStale,
  exceedsGasBudget,
  gasEatsTheEdge,
  isGasSpike,
  type FeeData,
  type GasOracle,
} from './gas.js';
export {
  ERC20_APPROVAL_ABI,
  APPROVAL_GAS_LIMIT,
  UINT256_MAX,
  readAllowance,
  checkApproval,
  buildApprovalTx,
  approvalCostKillsEdge,
  safeApproveCalls,
  type ApprovalMode,
  type ApprovalNeed,
  type ApprovalTx,
  type CheckApprovalArgs,
  type AllowanceReadArgs,
} from './approvals.js';
export {
  buildUnsignedTx,
  toSerializable,
  digestForSigning,
  assembleSignedTx,
  type UnsignedTx,
  type BuildTxArgs,
} from './tx-builder.js';
export {
  trackReceipt,
  classifyReceipt,
  outcomeToStatus,
  describeOutcome,
  type ReceiptOutcome,
  type TerminalTxStatus,
  type TrackReceiptArgs,
} from './receipts.js';
export {
  SWAP_ROUTER_02_ABI,
  UNISWAP_V3_SWAP_GAS_LIMIT,
  encodeExactInputSingle,
  minOutFromSlippage,
  type ExactInputSingleArgs,
  type ExactInputSingleCall,
} from './uniswap-router.js';

// Re-export the thin slice of viem the daemon's executor factory needs.
// Consumers should import these from `@b1dz/adapters-evm` rather than
// adding a direct viem dependency, so the workspace stays on a single
// resolved viem version (mixed versions produce nonsensical TS errors
// about Chain/Client incompatibility).
export { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
export { base, mainnet, arbitrum, optimism, polygon, avalanche } from 'viem/chains';
