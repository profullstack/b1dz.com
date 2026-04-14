import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CoinPayWalletProvider } from './index.js';
import { WalletProviderError } from '@b1dz/wallet-provider';

/** Build a fake child-process emitter that completes asynchronously
 *  with the given stdout/stderr/exit code. */
function fakeProc(opts: { stdout?: string; stderr?: string; code?: number; delayMs?: number } = {}) {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => { proc.emit('close', null); };
  setTimeout(() => {
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout, 'utf8'));
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr, 'utf8'));
    proc.emit('close', opts.code ?? 0);
  }, opts.delayMs ?? 0);
  return proc;
}

function makeProvider(opts: { stdout?: string; stderr?: string; code?: number } = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const spawnMock = vi.fn((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return fakeProc(opts) as never;
  });
  const provider = new CoinPayWalletProvider({
    cliPath: '/fake/coinpay',
    password: 'testpw',
    spawn: spawnMock as never,
  });
  return { provider, spawnMock, calls };
}

describe('CoinPayWalletProvider', () => {
  it('exposes the expected capabilities', () => {
    const { provider } = makeProvider();
    expect(provider.id).toBe('coinpay');
    expect(provider.capabilities()).toContain('sign-digest');
    expect(provider.capabilities()).toContain('sign-message');
    expect(provider.capabilities()).toContain('sign-solana-message');
  });

  it('lists supported chains spanning EVM + Solana', () => {
    const { provider } = makeProvider();
    const chains = provider.supportedChains();
    expect(chains).toContain('ethereum');
    expect(chains).toContain('base');
    expect(chains).toContain('polygon');
    expect(chains).toContain('solana');
  });

  it('signDigest passes --chain and --digest with mapped chain', async () => {
    const sig = '0x' + 'aa'.repeat(65);
    const { provider, calls } = makeProvider({ stdout: sig + '\n' });
    const out = await provider.signDigest({
      chain: 'ethereum',
      digestHex: '0x' + 'bb'.repeat(32),
    });
    expect(out).toBe(sig);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      'wallet', 'sign-digest',
      '--chain', 'ETH',
      '--digest', '0x' + 'bb'.repeat(32),
      '--password', 'testpw',
    ]);
  });

  it('maps base to ETH (same secp256k1 derivation path)', async () => {
    const { provider, calls } = makeProvider({ stdout: '0xdead\n' });
    await provider.signDigest({ chain: 'base', digestHex: '0x' + '01'.repeat(32) });
    expect(calls[0]!.args).toContain('ETH');
  });

  it('maps polygon to POL', async () => {
    const { provider, calls } = makeProvider({ stdout: '0xbeef\n' });
    await provider.signDigest({ chain: 'polygon', digestHex: '0x' + '02'.repeat(32) });
    expect(calls[0]!.args).toContain('POL');
  });

  it('signMessage forwards UTF-8 message and returns trimmed signature', async () => {
    const { provider, calls } = makeProvider({ stdout: '0xabc1c\n' });
    const out = await provider.signMessage({ chain: 'ethereum', message: 'hello' });
    expect(out).toBe('0xabc1c');
    expect(calls[0]!.args).toContain('--message');
    expect(calls[0]!.args).toContain('hello');
  });

  it('signMessage converts Uint8Array message to UTF-8 string', async () => {
    const { provider, calls } = makeProvider({ stdout: '0xsig\n' });
    const bytes = new TextEncoder().encode('binary-msg');
    await provider.signMessage({ chain: 'ethereum', message: bytes });
    expect(calls[0]!.args).toContain('binary-msg');
  });

  it('signSolanaMessage hex-prefixes raw bytes and forwards --index', async () => {
    const { provider, calls } = makeProvider({ stdout: '0x' + '11'.repeat(64) + '\n' });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const out = await provider.signSolanaMessage({ message: bytes, index: 3 });
    expect(out).toBe('0x' + '11'.repeat(64));
    expect(calls[0]!.args).toContain('--index');
    expect(calls[0]!.args).toContain('3');
    const messageArg = calls[0]!.args[calls[0]!.args.indexOf('--message') + 1];
    expect(messageArg).toBe('0x01020304');
  });

  it('signSolanaMessage accepts a hex string with or without 0x prefix', async () => {
    const { provider, calls } = makeProvider({ stdout: '0xsigsol\n' });
    await provider.signSolanaMessage({ message: 'deadbeef' });
    const messageArg = calls[0]!.args[calls[0]!.args.indexOf('--message') + 1];
    expect(messageArg).toBe('0xdeadbeef');
  });

  it('classifies "Wallet locked" stderr as locked error', async () => {
    const { provider } = makeProvider({ stderr: 'Error: Wallet locked\n', code: 1 });
    try {
      await provider.signDigest({ chain: 'ethereum', digestHex: '0x' + '00'.repeat(32) });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(WalletProviderError);
      expect((e as WalletProviderError).code).toBe('locked');
    }
  });

  it('classifies "Unknown wallet command" as not-supported (older CoinPay)', async () => {
    const { provider } = makeProvider({ stderr: 'Unknown wallet command: sign-digest\n', code: 1 });
    try {
      await provider.signDigest({ chain: 'ethereum', digestHex: '0x' + '00'.repeat(32) });
      expect.fail('should throw');
    } catch (e) {
      expect((e as WalletProviderError).code).toBe('not-supported');
    }
  });

  it('throws not-supported for chains we cannot map', async () => {
    const { provider } = makeProvider();
    try {
      await provider.signDigest({ chain: 'cosmos' as never, digestHex: '0x' + '00'.repeat(32) });
      expect.fail('should throw');
    } catch (e) {
      expect((e as WalletProviderError).code).toBe('not-supported');
    }
  });

  it('omits --password when none is configured', async () => {
    const { calls } = makeProvider();
    const provider = new CoinPayWalletProvider({
      cliPath: '/fake',
      // no password
      spawn: vi.fn((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return fakeProc({ stdout: '0xsig\n' }) as never;
      }) as never,
    });
    await provider.signDigest({ chain: 'ethereum', digestHex: '0x' + 'cc'.repeat(32) });
    expect(calls[0]!.args).not.toContain('--password');
  });

  it('passes --wallet-file when configured', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const provider = new CoinPayWalletProvider({
      cliPath: '/fake',
      password: 'pw',
      walletFile: '/tmp/custom.gpg',
      spawn: vi.fn((cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return fakeProc({ stdout: '0xsig\n' }) as never;
      }) as never,
    });
    await provider.signMessage({ chain: 'ethereum', message: 'hi' });
    expect(calls[0]!.args).toContain('--wallet-file');
    expect(calls[0]!.args).toContain('/tmp/custom.gpg');
  });

  it('getAddress parses the JSON-formatted addresses output', async () => {
    const stdout = '\nWallet Addresses:\n' + JSON.stringify({
      addresses: [
        { chain: 'BTC', address: 'bc1qfake' },
        { chain: 'ETH', address: '0xabc' },
        { chain: 'SOL', address: 'SoLana' },
      ],
    });
    const { provider } = makeProvider({ stdout });
    expect(await provider.getAddress('ethereum')).toBe('0xabc');
    const { provider: prov2 } = makeProvider({ stdout });
    expect(await prov2.getAddress('solana')).toBe('SoLana');
  });

  it('getAddress throws not-supported when the chain has no derived address', async () => {
    const stdout = '\nWallet Addresses:\n' + JSON.stringify({ addresses: [] });
    const { provider } = makeProvider({ stdout });
    try {
      await provider.getAddress('ethereum');
      expect.fail('should throw');
    } catch (e) {
      expect((e as WalletProviderError).code).toBe('not-supported');
    }
  });
});
