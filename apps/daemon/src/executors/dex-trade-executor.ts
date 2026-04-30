/**
 * DEX trade executor — implements the `DexTradeExecutor` seam exposed
 * by @b1dz/source-crypto-trade so the strategy source can dispatch
 * on-chain swaps for uniswap-v3 (Base) and jupiter (Solana) without
 * pulling wallet-service / viem / Solana signing into the strategy
 * package itself.
 *
 * Architecture parallels `UniswapV3BaseExecutor` (arb path): thin
 * wrapper over `UniswapV3Adapter.swap()` / `JupiterAdapter.swap()`.
 * Wallet-balance queries live here (not in the adapter) because the
 * adapters intentionally don't know about wallets — they're quote +
 * swap primitives.
 *
 * Arming: `maybeBuildDexTradeExecutor()` auto-arms any venue whose wallet
 * credentials are present. Set `DEX_TRADE_EXECUTION=false` to opt out.
 * `DEX_TRADE_EXECUTION=true` is still accepted as a legacy explicit arm
 * and makes missing-env warnings loud. Each venue is built independently
 * so operators can arm only the chain they have funds on.
 *
 * Required env (per venue):
 *   Uniswap V3 on Base:
 *     EVM_PRIVATE_KEY     hot wallet private key (0x-prefixed)
 *     BASE_RPC_URL        viem http transport
 *   Jupiter on Solana:
 *     SOLANA_PRIVATE_KEY  base58 / hex / JSON array secret
 *     SOLANA_RPC_URL      JSON-RPC endpoint
 *
 * Safety ceiling: every swap is capped by `DEX_TRADE_MAX_USD` (default
 * $20) so a config mistake in source-crypto-trade can't size a DEX
 * position larger than the operator intends.
 */

import type { DexTradeExecutor } from '@b1dz/source-crypto-trade';
import {
  UniswapV3Adapter,
  ViemGasOracle,
  base,
  createPublicClient,
  http,
  parseAbi,
  tokenFor,
  fromBaseUnits as fromEvmBaseUnits,
  type Address,
  type PublicClient,
} from '@b1dz/adapters-evm';
import { WalletService } from '@b1dz/wallet-service';
import {
  DirectEvmWalletProvider,
  DirectSolanaWalletProvider,
} from '@b1dz/wallet-direct';
import { JupiterAdapter, SOLANA_MINTS, fromBaseUnits as fromSolanaBaseUnits } from '@b1dz/adapters-solana';

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);

function dexTradePairs(): string[] {
  const raw = process.env.DCA_DEX_TRADE_PAIRS ?? process.env.ARB_DEX_PAIRS ?? 'SOL-USD,BONK-USD,WIF-USD,JUP-USD,JTO-USD';
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

function floatEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function isDexTradeExplicitlyEnabled(): boolean {
  return (process.env.DEX_TRADE_EXECUTION ?? '').trim().toLowerCase() === 'true';
}

function isDexTradeDisabled(): boolean {
  return (process.env.DEX_TRADE_EXECUTION ?? '').trim().toLowerCase() === 'false';
}

export async function maybeBuildDexTradeExecutor(): Promise<DexTradeExecutor | null> {
  if (isDexTradeDisabled()) return null;
  const explicit = isDexTradeExplicitlyEnabled();

  const uniswap = await maybeBuildUniswapLeg(explicit);
  const jupiter = maybeBuildJupiterLeg(explicit);
  if (!uniswap && !jupiter) {
    if (explicit) console.warn('[trade] DEX_TRADE_EXECUTION=true but neither Uniswap nor Jupiter could arm (missing env) — DEX execution skipped');
    return null;
  }

  const maxTradeUsd = floatEnv('DEX_TRADE_MAX_USD', 20);

  return {
    async quoteBalanceUsd(venue: string): Promise<number | null> {
      if (venue === 'uniswap-v3') return uniswap?.usdcBalanceUsd() ?? null;
      if (venue === 'jupiter') return jupiter?.usdcBalanceUsd() ?? null;
      return null;
    },

    async openPositions() {
      const out: Array<{ venue: string; pair: string; volume: number; entryPrice: number; entryTime: number; reason: string }> = [];
      if (uniswap) out.push(...await uniswap.openPositions());
      if (jupiter) out.push(...await jupiter.openPositions());
      return out;
    },

    async buy(args) {
      if (args.amountUsd > maxTradeUsd) {
        return { ok: false, message: `DEX buy $${args.amountUsd.toFixed(2)} > DEX_TRADE_MAX_USD $${maxTradeUsd}` };
      }
      if (args.venue === 'uniswap-v3') {
        if (!uniswap) return { ok: false, message: 'uniswap-v3 leg not armed' };
        return uniswap.buy(args);
      }
      if (args.venue === 'jupiter') {
        if (!jupiter) return { ok: false, message: 'jupiter leg not armed' };
        return jupiter.buy(args);
      }
      return { ok: false, message: `unsupported DEX venue ${args.venue}` };
    },

    async sell(args) {
      if (args.venue === 'uniswap-v3') {
        if (!uniswap) return { ok: false, message: 'uniswap-v3 leg not armed' };
        return uniswap.sell(args);
      }
      if (args.venue === 'jupiter') {
        if (!jupiter) return { ok: false, message: 'jupiter leg not armed' };
        return jupiter.sell(args);
      }
      return { ok: false, message: `unsupported DEX venue ${args.venue}` };
    },
  };
}

// ─── Uniswap V3 on Base ───────────────────────────────────────────

interface VenueLeg {
  usdcBalanceUsd(): Promise<number>;
  openPositions(): Promise<Array<{ venue: string; pair: string; volume: number; entryPrice: number; entryTime: number; reason: string }>>;
  buy(args: {
    pair: string;
    amountUsd: number;
    slippageBps: number;
  }): Promise<{ ok: boolean; message: string; fillPrice?: number; baseVolume?: number; txId?: string }>;
  sell(args: {
    pair: string;
    baseVolume: number;
    slippageBps: number;
  }): Promise<{ ok: boolean; message: string; fillPrice?: number; quoteAmountUsd?: number; txId?: string }>;
}

async function maybeBuildUniswapLeg(warnOnMissingEnv = false): Promise<VenueLeg | null> {
  const privateKey = process.env.EVM_PRIVATE_KEY;
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!privateKey) {
    if (warnOnMissingEnv) console.warn('[trade] DEX_TRADE_EXECUTION=true but EVM_PRIVATE_KEY missing — uniswap-v3 leg skipped');
    return null;
  }
  if (!rpcUrl) {
    if (warnOnMissingEnv) console.warn('[trade] DEX_TRADE_EXECUTION=true but BASE_RPC_URL missing — uniswap-v3 leg skipped');
    return null;
  }

  const wallet = new DirectEvmWalletProvider({ privateKey: privateKey as `0x${string}` });
  const walletAddress = (await wallet.getAddress('base')) as Address;
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) }) as unknown as PublicClient;
  const gasOracle = new ViemGasOracle({ clients: { base: client } });
  const walletService = new WalletService({
    clients: { base: client },
    walletProvider: wallet,
    gasOracle,
  });

  const adapter = new UniswapV3Adapter({ chain: 'base', rpcUrl, gasOracle });
  const usdc = tokenFor('base', 'USDC');
  if (!usdc) throw new Error('base USDC not in token registry');

  console.log(`[trade] uniswap-v3 leg armed  wallet=${walletAddress}`);

  return {
    async usdcBalanceUsd() {
      const raw = (await client.readContract({
        address: usdc.address as Address,
        abi: ERC20_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [walletAddress],
      })) as bigint;
      return Number(raw) / 10 ** usdc.decimals;
    },

    async openPositions() {
      const out: Array<{ venue: string; pair: string; volume: number; entryPrice: number; entryTime: number; reason: string }> = [];
      for (const pair of dexTradePairs()) {
        const baseSymbol = pair.split('-')[0]?.toUpperCase();
        if (!baseSymbol || baseSymbol === 'USDC' || baseSymbol === 'USDT' || baseSymbol === 'USD') continue;
        const token = tokenFor('base', baseSymbol);
        if (!token || token.address.toLowerCase() === usdc.address.toLowerCase()) continue;
        try {
          const raw = (await client.readContract({
            address: token.address as Address,
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [walletAddress],
          })) as bigint;
          if (raw <= 0n) continue;
          const volume = Number.parseFloat(fromEvmBaseUnits(raw.toString(), token.decimals));
          if (!Number.isFinite(volume) || volume <= 0) continue;
          const quote = await adapter.quote({ pair, side: 'sell', amountIn: volume.toString(), chain: 'base' }).catch(() => null);
          const quoteUsd = quote ? Number.parseFloat(quote.amountOut) : NaN;
          const entryPrice = Number.isFinite(quoteUsd) && quoteUsd > 0 ? quoteUsd / volume : 0;
          if (!(entryPrice > 0)) continue;
          out.push({
            venue: 'uniswap-v3',
            pair,
            volume,
            entryPrice,
            entryTime: Date.now(),
            reason: 'wallet balance current-price restore',
          });
        } catch (e) {
          console.warn(`[trade] uniswap-v3 holding lookup failed for ${pair}: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      return out;
    },

    async buy(args) {
      const result = await adapter.swap({
        pair: args.pair,
        side: 'buy',
        amountIn: args.amountUsd.toString(),
        walletAddress,
        // WalletService.execute returns txHash as `0x${string}` | null; the
        // adapter's inline type is narrower (txHash?: string). Cast once —
        // runtime shape is compatible.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        walletService: walletService as any,
        slippageBps: args.slippageBps,
      });
      if (result.status !== 'filled') {
        return { ok: false, message: `uniswap buy ${result.status}: ${result.resolvedReason}`, txId: result.txHash };
      }
      const amountIn = Number.parseFloat(result.amountIn);
      const amountOut = result.amountOut ? Number.parseFloat(result.amountOut) : NaN;
      if (!Number.isFinite(amountOut) || amountOut <= 0) {
        // Swap landed but we don't know the exact fill — signal success
        // with best-effort numbers; position tracking can still exit via
        // spot price later.
        return { ok: true, message: `filled (amountOut unknown)`, txId: result.txHash };
      }
      const fillPrice = amountIn / amountOut;
      return { ok: true, message: `filled`, fillPrice, baseVolume: amountOut, txId: result.txHash };
    },

    async sell(args) {
      const result = await adapter.swap({
        pair: args.pair,
        side: 'sell',
        amountIn: args.baseVolume.toString(),
        walletAddress,
        // WalletService.execute returns txHash as `0x${string}` | null; the
        // adapter's inline type is narrower (txHash?: string). Cast once —
        // runtime shape is compatible.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        walletService: walletService as any,
        slippageBps: args.slippageBps,
      });
      if (result.status !== 'filled') {
        return { ok: false, message: `uniswap sell ${result.status}: ${result.resolvedReason}`, txId: result.txHash };
      }
      const amountIn = Number.parseFloat(result.amountIn);
      const amountOut = result.amountOut ? Number.parseFloat(result.amountOut) : NaN;
      if (!Number.isFinite(amountOut) || amountOut <= 0) {
        return { ok: true, message: `filled (amountOut unknown)`, txId: result.txHash };
      }
      const fillPrice = amountOut / amountIn;
      return { ok: true, message: `filled`, fillPrice, quoteAmountUsd: amountOut, txId: result.txHash };
    },
  };
}

// ─── Jupiter on Solana ────────────────────────────────────────────

/** Translate CEX-style "X-USD" to "X-USDC" for Jupiter (USD is not an SPL token). */
function solanaPair(pair: string): string {
  return pair.replace(/-USD$/, '-USDC');
}

function maybeBuildJupiterLeg(warnOnMissingEnv = false): VenueLeg | null {
  const secret = process.env.SOLANA_PRIVATE_KEY;
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!secret) {
    if (warnOnMissingEnv) console.warn('[trade] DEX_TRADE_EXECUTION=true but SOLANA_PRIVATE_KEY missing — jupiter leg skipped');
    return null;
  }
  if (!rpcUrl) {
    if (warnOnMissingEnv) console.warn('[trade] DEX_TRADE_EXECUTION=true but SOLANA_RPC_URL missing — jupiter leg skipped');
    return null;
  }

  const wallet = new DirectSolanaWalletProvider({ secretKey: secret });
  let userPublicKeyCache: string | null = null;
  async function userPublicKey(): Promise<string> {
    if (!userPublicKeyCache) userPublicKeyCache = await wallet.getAddress('solana');
    return userPublicKeyCache;
  }

  const adapter = new JupiterAdapter({});
  const usdcMint = SOLANA_MINTS.USDC!;

  console.log('[trade] jupiter leg armed');

  return {
    async usdcBalanceUsd() {
      const pubkey = await userPublicKey();
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [pubkey, { mint: usdcMint.mint }, { encoding: 'jsonParsed' }],
        }),
      });
      if (!res.ok) throw new Error(`solana rpc ${res.status}`);
      const body = (await res.json()) as {
        result?: { value?: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }> };
        error?: { message: string };
      };
      if (body.error) throw new Error(body.error.message);
      const accounts = body.result?.value ?? [];
      let total = 0;
      for (const acct of accounts) {
        const amt = acct.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof amt === 'number' && Number.isFinite(amt)) total += amt;
      }
      return total;
    },

    async openPositions() {
      const pubkey = await userPublicKey();
      const pairs = dexTradePairs();
      const out: Array<{ venue: string; pair: string; volume: number; entryPrice: number; entryTime: number; reason: string }> = [];
      for (const pair of pairs) {
        const baseSymbol = pair.split('-')[0]?.toUpperCase();
        if (!baseSymbol || baseSymbol === 'USDC' || baseSymbol === 'USDT' || baseSymbol === 'USD') continue;
        const mint = SOLANA_MINTS[baseSymbol];
        if (!mint) continue;
        try {
          const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getTokenAccountsByOwner',
              params: [pubkey, { mint: mint.mint }, { encoding: 'jsonParsed' }],
            }),
          });
          if (!res.ok) throw new Error(`solana rpc ${res.status}`);
          const body = (await res.json()) as {
            result?: { value?: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount?: string; uiAmount?: number } } } } } }> };
            error?: { message: string };
          };
          if (body.error) throw new Error(body.error.message);
          let volume = 0;
          for (const acct of body.result?.value ?? []) {
            const tokenAmount = acct.account?.data?.parsed?.info?.tokenAmount;
            const uiAmount = typeof tokenAmount?.uiAmount === 'number'
              ? tokenAmount.uiAmount
              : Number.parseFloat(fromSolanaBaseUnits(tokenAmount?.amount ?? '0', mint.decimals));
            if (Number.isFinite(uiAmount)) volume += uiAmount;
          }
          if (!(volume > 0)) continue;
          const quote = await adapter.quote({ pair, side: 'sell', amountIn: volume.toString(), chain: 'solana' }).catch(() => null);
          const quoteUsd = quote ? Number.parseFloat(quote.amountOut) : NaN;
          const entryPrice = Number.isFinite(quoteUsd) && quoteUsd > 0 ? quoteUsd / volume : 0;
          if (!(entryPrice > 0)) continue;
          out.push({
            venue: 'jupiter',
            pair,
            volume,
            entryPrice,
            entryTime: Date.now(),
            reason: 'wallet balance current-price restore',
          });
        } catch (e) {
          console.warn(`[trade] jupiter holding lookup failed for ${pair}: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      return out;
    },

    async buy(args) {
      const pubkey = await userPublicKey();
      const result = await adapter.swap({
        pair: solanaPair(args.pair),
        side: 'buy',
        amountIn: args.amountUsd.toString(),
        walletProvider: wallet,
        userPublicKey: pubkey,
        rpcUrl,
        slippageBps: args.slippageBps,
      });
      if (result.status !== 'filled') {
        return { ok: false, message: `jupiter buy ${result.status}: ${result.resolvedReason}`, txId: result.signature };
      }
      const amountIn = result.amountIn ? Number.parseFloat(result.amountIn) : NaN;
      const amountOut = result.amountOut ? Number.parseFloat(result.amountOut) : NaN;
      if (!Number.isFinite(amountOut) || amountOut <= 0 || !Number.isFinite(amountIn)) {
        return { ok: true, message: `filled (amountOut unknown)`, txId: result.signature };
      }
      const fillPrice = amountIn / amountOut;
      return { ok: true, message: `filled`, fillPrice, baseVolume: amountOut, txId: result.signature };
    },

    async sell(args) {
      const pubkey = await userPublicKey();
      const result = await adapter.swap({
        pair: solanaPair(args.pair),
        side: 'sell',
        amountIn: args.baseVolume.toString(),
        walletProvider: wallet,
        userPublicKey: pubkey,
        rpcUrl,
        slippageBps: args.slippageBps,
      });
      if (result.status !== 'filled') {
        return { ok: false, message: `jupiter sell ${result.status}: ${result.resolvedReason}`, txId: result.signature };
      }
      const amountIn = result.amountIn ? Number.parseFloat(result.amountIn) : NaN;
      const amountOut = result.amountOut ? Number.parseFloat(result.amountOut) : NaN;
      if (!Number.isFinite(amountOut) || amountOut <= 0 || !Number.isFinite(amountIn)) {
        return { ok: true, message: `filled (amountOut unknown)`, txId: result.signature };
      }
      const fillPrice = amountOut / amountIn;
      return { ok: true, message: `filled`, fillPrice, quoteAmountUsd: amountOut, txId: result.signature };
    },
  };
}
