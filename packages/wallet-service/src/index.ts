/**
 * Wallet service (PRD §29 Phase 3).
 *
 * Stitches the EVM execution legos into a single call the trade
 * daemon invokes for live transactions:
 *
 *   build → digest → WalletProvider.signDigest → assemble → broadcast
 *   → trackReceipt → resolve
 *
 * Keeps the daemon free of viem / wallet-provider plumbing. The
 * daemon hands this service an intent (from, to, data, value, gas)
 * and gets back a structured outcome it can relay to the event
 * channel's terminal status.
 */

import {
  buildUnsignedTx,
  digestForSigning,
  assembleSignedTx,
  trackReceipt,
  outcomeToStatus,
  describeOutcome,
  type FeeData,
  type GasOracle,
  type ReceiptOutcome,
  type TerminalTxStatus,
  type EvmChain,
} from '@b1dz/adapters-evm';
import type { WalletProvider } from '@b1dz/wallet-provider';
import type { Address, Hex, PublicClient } from 'viem';
import { NonceManager, type NonceStore } from './nonce.js';

export { NonceManager, InMemoryNonceStore, type NonceStore } from './nonce.js';

export interface ExecuteIntent {
  chain: EvmChain;
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  /** Pre-estimated gas limit. Caller should already have bumped this
   *  by a safety margin before handing it over. */
  gasLimit: bigint;
}

export interface ExecutionResult {
  /** Broadcast tx hash. Null if we failed before submission (e.g.
   *  signing error, nonce miss). */
  txHash: Hex | null;
  outcome: ReceiptOutcome | null;
  status: TerminalTxStatus | 'aborted';
  resolvedReason: string;
  /** Fee data snapshot used to build the tx — kept for audit logs. */
  feeData: FeeData | null;
}

export interface WalletServiceArgs {
  clients: Partial<Record<EvmChain, PublicClient>>;
  walletProvider: WalletProvider;
  gasOracle: GasOracle;
  nonceStore?: NonceStore;
  /** Pre-submission check — return null to proceed or a blocker
   *  string to abort. Lets the daemon wire inventory checks and kill
   *  switches into the execution path without coupling them here. */
  preflight?: (intent: ExecuteIntent) => Promise<string | null>;
  receiptPollMs?: number;
  receiptTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class WalletService {
  private readonly clients: WalletServiceArgs['clients'];
  private readonly walletProvider: WalletProvider;
  private readonly gasOracle: GasOracle;
  private readonly nonces: NonceManager;
  private readonly preflight: WalletServiceArgs['preflight'];
  private readonly receiptPollMs: number;
  private readonly receiptTimeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(args: WalletServiceArgs) {
    this.clients = args.clients;
    this.walletProvider = args.walletProvider;
    this.gasOracle = args.gasOracle;
    this.preflight = args.preflight;
    this.receiptPollMs = args.receiptPollMs ?? 2_000;
    this.receiptTimeoutMs = args.receiptTimeoutMs ?? 120_000;
    this.log = args.log ?? ((m) => console.log(m));
    this.nonces = new NonceManager({
      clients: args.clients,
      store: args.nonceStore,
    });
  }

  async execute(intent: ExecuteIntent): Promise<ExecutionResult> {
    const client = this.clients[intent.chain];
    if (!client) {
      return abort(`no PublicClient wired for chain ${intent.chain}`);
    }
    if (this.preflight) {
      const block = await this.preflight(intent);
      if (block) return abort(`preflight: ${block}`);
    }

    let feeData: FeeData;
    try {
      feeData = await this.gasOracle.getFeeData(intent.chain);
    } catch (e) {
      return abort(`gas oracle: ${(e as Error).message.slice(0, 200)}`);
    }

    let nonce: number;
    try {
      nonce = await this.nonces.next(intent.chain, intent.from);
    } catch (e) {
      return abort(`nonce: ${(e as Error).message.slice(0, 200)}`);
    }

    let signedTx: Hex;
    let txHash: Hex;
    try {
      const unsigned = buildUnsignedTx({
        chain: intent.chain,
        from: intent.from,
        to: intent.to,
        data: intent.data,
        value: intent.value,
        gasLimit: intent.gasLimit,
        nonce,
        feeData,
      });
      const digest = digestForSigning(unsigned);
      if (!this.walletProvider.signDigest) {
        throw new Error(`wallet-provider ${this.walletProvider.id} does not implement signDigest`);
      }
      const sig = await this.walletProvider.signDigest({ chain: intent.chain, digestHex: digest }) as Hex;
      signedTx = assembleSignedTx(unsigned, sig);
    } catch (e) {
      await this.nonces.resync(intent.chain, intent.from);
      return abort(`sign: ${(e as Error).message.slice(0, 200)}`, feeData);
    }

    try {
      // viem's sendRawTransaction returns the hash as 0x-prefixed hex.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      txHash = await (client as any).sendRawTransaction({ serializedTransaction: signedTx });
    } catch (e) {
      await this.nonces.resync(intent.chain, intent.from);
      return abort(`broadcast: ${(e as Error).message.slice(0, 200)}`, feeData);
    }

    this.log(`[wallet-service] broadcast ${txHash.slice(0, 10)}… chain=${intent.chain} nonce=${nonce}`);

    const outcome = await trackReceipt({
      client,
      txHash,
      pollIntervalMs: this.receiptPollMs,
      timeoutMs: this.receiptTimeoutMs,
    });
    const status = outcomeToStatus(outcome);
    const reason = describeOutcome(txHash, outcome, intent.from);
    this.log(`[wallet-service] ${status} ${reason}`);

    if (status !== 'filled') {
      // Stuck or reverted txes probably consumed the nonce anyway
      // (reverted did, stuck may have been replaced). Force a resync
      // so the next allocation doesn't double-use.
      await this.nonces.resync(intent.chain, intent.from);
    }

    return { txHash, outcome, status, resolvedReason: reason, feeData };
  }
}

function abort(reason: string, feeData: FeeData | null = null): ExecutionResult {
  return { txHash: null, outcome: null, status: 'aborted', resolvedReason: reason, feeData };
}
