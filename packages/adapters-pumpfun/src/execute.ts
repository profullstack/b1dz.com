/**
 * Pump.fun live trade execution via pumpportal.fun (PRD §16.2, §29).
 *
 * pumpportal.fun provides a `trade-local` endpoint that returns a
 * pre-built serialized Solana transaction (raw bytes, not base64).
 * We:
 *   1. GET the raw tx bytes from pumpportal.
 *   2. Parse the Solana wire format with parseTransaction().
 *   3. Sign the message bytes via WalletProvider.signSolanaMessage().
 *   4. Reassemble and submit via sendTransaction JSON-RPC.
 *   5. Poll for confirmation with trackSolanaTransaction().
 *
 * Also provides getSolanaTokenBalance() for reading a wallet's SPL
 * token balance (used to determine sell quantity after a confirmed buy).
 */

import type { WalletProvider } from '@b1dz/wallet-provider';
import {
  parseTransaction,
  reassembleTransaction,
  trackSolanaTransaction,
  base58decode,
  base58encode,
} from '@b1dz/adapters-solana';

const PUMPPORTAL_BASE = 'https://pumpportal.fun/api';

export interface PumpFunTradeParams {
  /** Base58-encoded wallet public key. */
  publicKey: string;
  action: 'buy' | 'sell';
  /** Token mint address (base58). */
  mint: string;
  /** SOL amount for buys (denominatedInSol=true). */
  amountSol?: number;
  /** Raw token units for sells (denominatedInSol=false). */
  amountTokens?: number;
  /** Slippage tolerance in percent. Default: 10. */
  slippagePct?: number;
  /** Priority fee in SOL. Default: 0.0001. */
  priorityFeeSol?: number;
  /** Pool to route through. Default: 'pump'. */
  pool?: 'pump' | 'raydium';
}

export interface PumpFunTradeResult {
  signature: string;
  status: 'confirmed' | 'reverted' | 'timeout';
  error?: string;
}

/**
 * Execute a buy or sell on pump.fun via pumpportal.fun.
 *
 * The pumpportal endpoint returns raw transaction bytes
 * (application/octet-stream). We sign and submit them using the same
 * infra as Jupiter swaps.
 */
export async function executePumpFunTrade(
  params: PumpFunTradeParams,
  walletProvider: WalletProvider,
  rpcUrl: string,
): Promise<PumpFunTradeResult> {
  const {
    publicKey,
    action,
    mint,
    amountSol,
    amountTokens,
    slippagePct = 10,
    priorityFeeSol = 0.0001,
    pool = 'pump',
  } = params;

  // pumpportal /trade-local expects POST with a JSON body (not GET+query).
  const tradeBody: Record<string, unknown> = {
    publicKey,
    action,
    mint,
    slippage: slippagePct,
    priorityFee: priorityFeeSol,
    pool,
    ...(action === 'buy'
      ? { denominatedInSol: 'true', amount: amountSol ?? 0.01 }
      : { denominatedInSol: 'false', amount: amountTokens ?? 0 }),
  };

  // Fetch the raw serialized transaction bytes.
  let txBytes: Uint8Array;
  try {
    const res = await fetch(`${PUMPPORTAL_BASE}/trade-local`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/octet-stream',
      },
      body: JSON.stringify(tradeBody),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        signature: '',
        status: 'reverted',
        error: `pumpportal ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    const buf = await res.arrayBuffer();
    txBytes = new Uint8Array(buf);
  } catch (e) {
    return {
      signature: '',
      status: 'reverted',
      error: `pumpportal fetch: ${(e as Error).message}`,
    };
  }

  if (txBytes.length === 0) {
    return { signature: '', status: 'reverted', error: 'pumpportal returned empty transaction' };
  }

  // Parse, sign, reassemble.
  let signature: string;
  try {
    const parsed = parseTransaction(txBytes);
    if (parsed.numSignatures < 1) {
      return { signature: '', status: 'reverted', error: 'tx has no signature slots' };
    }
    if (!walletProvider.signSolanaMessage) {
      return {
        signature: '',
        status: 'reverted',
        error: `wallet provider ${walletProvider.id} does not support signSolanaMessage`,
      };
    }
    const sigB58 = await walletProvider.signSolanaMessage({ message: parsed.message });
    const sig = base58decode(sigB58);
    if (sig.length !== 64) {
      return { signature: '', status: 'reverted', error: `signature expected 64 bytes, got ${sig.length}` };
    }
    // Insert our signature at slot 0 (fee payer).
    const sigs = [sig, ...parsed.signatures.slice(1)];
    const signed = reassembleTransaction(sigs, parsed.message);

    // Derive the transaction signature (first sig, base58-encoded).
    signature = base58encode(sig);

    // Submit via JSON-RPC sendTransaction.
    //
    // skipPreflight=true: pumpportal embeds a recent blockhash on its end,
    // but if the operator's SOLANA_RPC_URL lags the cluster tip even by a
    // few slots, preflight rejects with "Blockhash not found" before the
    // leader ever sees the tx. Skipping preflight defers validation to
    // the leader, which compares against actual cluster state. Cost of a
    // bad tx getting through is the priority fee (~$0.02 at 0.0001 SOL),
    // which is dwarfed by the current 100% rejection rate on lagging RPCs.
    const signedB64 = Buffer.from(signed).toString('base64');
    const rpcRes = await rpcCall<string>(rpcUrl, 'sendTransaction', [
      signedB64,
      { encoding: 'base64', skipPreflight: true, maxRetries: 5 },
    ]);
    // The RPC returns the actual signature string; prefer that over our
    // local derivation in case of mismatch.
    if (rpcRes && typeof rpcRes === 'string') {
      signature = rpcRes;
    }
  } catch (e) {
    return {
      signature: '',
      status: 'reverted',
      error: `sign/send: ${(e as Error).message}`,
    };
  }

  // Poll for confirmation.
  try {
    const outcome = await trackSolanaTransaction({
      rpcUrl,
      signature,
      timeoutMs: 60_000,
      pollIntervalMs: 1_500,
    });
    if (outcome.kind === 'confirmed') {
      return { signature, status: 'confirmed' };
    }
    if (outcome.kind === 'reverted') {
      return { signature, status: 'reverted', error: outcome.err };
    }
    return { signature, status: 'timeout' };
  } catch (e) {
    return { signature, status: 'timeout', error: `track: ${(e as Error).message}` };
  }
}

// ─── SPL token balance ────────────────────────────────────────────

interface TokenAccountValue {
  account: {
    data: {
      parsed: {
        info: {
          tokenAmount: {
            amount: string;
          };
        };
      };
    };
  };
}

interface GetTokenAccountsResult {
  value: TokenAccountValue[];
}

/**
 * Fetch the raw SPL token balance for a wallet + mint pair.
 *
 * Uses the `getTokenAccountsByOwner` JSON-RPC method with the SPL Token
 * program filter. Returns 0n if the wallet has no token account for that
 * mint.
 *
 * @param walletAddressB58 Base58-encoded Solana wallet address
 * @param mintAddressB58   Base58-encoded token mint address
 * @param rpcUrl           Solana RPC endpoint (JSON-RPC 2.0)
 * @returns                Raw token units as bigint (0n if none)
 */
export async function getSolanaTokenBalance(
  walletAddressB58: string,
  mintAddressB58: string,
  rpcUrl: string,
): Promise<bigint> {
  const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const result = await rpcCall<GetTokenAccountsResult>(
    rpcUrl,
    'getTokenAccountsByOwner',
    [
      walletAddressB58,
      { mint: mintAddressB58 },
      { encoding: 'jsonParsed', programId: SPL_TOKEN_PROGRAM },
    ],
  );
  const accounts = result.value ?? [];
  if (accounts.length === 0) return 0n;
  // Sum all token accounts for this mint (should normally be one).
  let total = 0n;
  for (const acct of accounts) {
    const amountStr = acct.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amountStr) {
      try { total += BigInt(amountStr); } catch { /* skip malformed */ }
    }
  }
  return total;
}

// ─── JSON-RPC helper ─────────────────────────────────────────────

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rpc ${method} ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`rpc ${method}: no result`);
  return body.result;
}
