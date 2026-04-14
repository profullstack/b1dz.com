/**
 * CoinPay-CLI-backed wallet provider (PRD §11B).
 *
 * Shells out to the CoinPay CLI for every signing operation. This
 * keeps key material inside the GPG-encrypted CoinPay vault and out
 * of the b1dz daemon's process memory.
 *
 * Maps b1dz's chain slugs to CoinPay's chain codes. b1dz uses
 * "ethereum" / "polygon" / "solana", CoinPay uses "ETH" / "POL" /
 * "SOL".
 *
 * Required CoinPay version: includes the `wallet sign-digest` /
 * `sign-message` / `sign-solana` commands (CoinPay PR
 * "feat: arbitrary transaction signing for external wallet
 * providers"). Older CoinPay binaries will produce an `Unknown
 * wallet command` error from the CLI.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import {
  WalletProviderError,
  type WalletProvider,
  type WalletChain,
  type ProviderCapability,
  type SignDigestRequest,
  type SignMessageRequest,
  type SignSolanaTxRequest,
} from '@b1dz/wallet-provider';

const B1DZ_TO_COINPAY_CHAIN: Record<WalletChain, string> = {
  ethereum: 'ETH',
  base: 'ETH',         // Base uses the same secp256k1 path as ETH (BIP44 60)
  avalanche: 'ETH',
  arbitrum: 'ETH',
  optimism: 'ETH',
  polygon: 'POL',
  bnb: 'BNB',
  solana: 'SOL',
};

const SUPPORTED_CHAINS: readonly WalletChain[] = [
  'ethereum', 'base', 'avalanche', 'arbitrum', 'optimism', 'polygon', 'bnb', 'solana',
];

export interface CoinPayWalletProviderOptions {
  /** Path to the coinpay CLI binary. Default: `coinpay` (on PATH). */
  cliPath?: string;
  /** Wallet password — read from env COINPAY_WALLET_PASSWORD by default. */
  password?: string;
  /** GPG-encrypted wallet file path. Falls back to CoinPay's default
   *  ~/.coinpay-wallet.gpg when not set. */
  walletFile?: string;
  /** Per-CLI-call timeout in ms. */
  timeoutMs?: number;
  /** Spawner injection for tests. */
  spawn?: typeof spawn;
}

/** Result of running a coinpay subcommand. */
interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class CoinPayWalletProvider implements WalletProvider {
  readonly id = 'coinpay';
  private readonly cliPath: string;
  private readonly password: string | undefined;
  private readonly walletFile: string | undefined;
  private readonly timeoutMs: number;
  private readonly spawnImpl: typeof spawn;

  constructor(opts: CoinPayWalletProviderOptions = {}) {
    this.cliPath = opts.cliPath ?? process.env.COINPAY_CLI_PATH ?? 'coinpay';
    this.password = opts.password ?? process.env.COINPAY_WALLET_PASSWORD;
    this.walletFile = opts.walletFile ?? process.env.COINPAY_WALLET_FILE;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.spawnImpl = opts.spawn ?? spawn;
  }

  capabilities(): readonly ProviderCapability[] {
    return ['sign-digest', 'sign-message', 'sign-solana-message', 'get-address', 'get-balance'];
  }

  supportedChains(): readonly WalletChain[] {
    return SUPPORTED_CHAINS;
  }

  async getAddress(chain: WalletChain): Promise<string> {
    const cpChain = mapChain(chain);
    // `wallet addresses` returns JSON; we filter to the chain we want.
    const r = await this.run(['wallet', 'addresses']);
    if (r.code !== 0) throw new WalletProviderError('internal', r.stderr || r.stdout);
    const json = parseAddressesJson(r.stdout);
    const found = json.find((a) => a.chain === cpChain);
    if (!found) {
      throw new WalletProviderError('not-supported', `no address derived for chain ${cpChain}`);
    }
    return found.address;
  }

  async getBalance(chain: WalletChain): Promise<string> {
    const cpChain = mapChain(chain);
    const r = await this.run(['wallet', 'balance', cpChain]);
    if (r.code !== 0) throw new WalletProviderError('internal', r.stderr || r.stdout);
    // CLI prints "Balances:\n{...json...}". Strip prefix.
    const idx = r.stdout.indexOf('{');
    const body = idx >= 0 ? r.stdout.slice(idx) : r.stdout;
    return body.trim();
  }

  async signDigest(req: SignDigestRequest): Promise<string> {
    const cpChain = mapChain(req.chain);
    const r = await this.run([
      'wallet', 'sign-digest',
      '--chain', cpChain,
      '--digest', req.digestHex,
    ]);
    if (r.code !== 0) {
      throw new WalletProviderError(classifyError(r), r.stderr || r.stdout);
    }
    return r.stdout.trim();
  }

  async signMessage(req: SignMessageRequest): Promise<string> {
    const cpChain = mapChain(req.chain);
    const message = typeof req.message === 'string'
      ? req.message
      : Buffer.from(req.message).toString('utf8');
    const r = await this.run([
      'wallet', 'sign-message',
      '--chain', cpChain,
      '--message', message,
    ]);
    if (r.code !== 0) {
      throw new WalletProviderError(classifyError(r), r.stderr || r.stdout);
    }
    return r.stdout.trim();
  }

  async signSolanaMessage(req: SignSolanaTxRequest): Promise<string> {
    const messageHex = typeof req.message === 'string'
      ? (req.message.startsWith('0x') ? req.message : '0x' + req.message)
      : '0x' + Buffer.from(req.message).toString('hex');
    const args = ['wallet', 'sign-solana', '--message', messageHex];
    if (req.index !== undefined) args.push('--index', String(req.index));
    const r = await this.run(args);
    if (r.code !== 0) {
      throw new WalletProviderError(classifyError(r), r.stderr || r.stdout);
    }
    return r.stdout.trim();
  }

  // ─── Internals ────────────────────────────────────────────────

  private buildArgs(args: string[]): string[] {
    const final = [...args];
    if (this.password) {
      final.push('--password', this.password);
    }
    if (this.walletFile) {
      final.push('--wallet-file', this.walletFile);
    }
    return final;
  }

  private run(args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const opts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] };
      const proc = this.spawnImpl(this.cliPath, this.buildArgs(args), opts);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new WalletProviderError('network', `coinpay CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
      proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
      proc.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(new WalletProviderError('internal', `failed to spawn coinpay: ${e.message}`));
      });
      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? -1 });
      });
    });
  }
}

function mapChain(chain: WalletChain): string {
  const cp = B1DZ_TO_COINPAY_CHAIN[chain];
  if (!cp) throw new WalletProviderError('not-supported', `unsupported chain ${chain}`);
  return cp;
}

interface AddressJsonEntry { chain: string; address: string }
function parseAddressesJson(stdout: string): AddressJsonEntry[] {
  // CLI prints "\nWallet Addresses:\n{...}". Find the first `{` and parse.
  const idx = stdout.indexOf('{');
  if (idx < 0) return [];
  try {
    const parsed = JSON.parse(stdout.slice(idx)) as { addresses?: AddressJsonEntry[] };
    return parsed.addresses ?? [];
  } catch {
    return [];
  }
}

function classifyError(r: RunResult): WalletProviderError['code'] {
  const blob = (r.stderr + r.stdout).toLowerCase();
  if (blob.includes('locked') || blob.includes('password')) return 'locked';
  if (blob.includes('unsupported') || blob.includes('unknown')) return 'not-supported';
  if (blob.includes('rejected') || blob.includes('cancel')) return 'rejected';
  return 'internal';
}
