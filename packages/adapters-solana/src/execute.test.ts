import { describe, expect, it } from 'vitest';
import {
  parseTransaction,
  reassembleTransaction,
  signAndSendJupiterTx,
  trackSolanaTransaction,
  fetchJupiterSwap,
} from './execute.js';
import { base58encode } from './base58.js';
import type { WalletProvider } from '@b1dz/wallet-provider';

describe('parseTransaction + reassembleTransaction', () => {
  it('round-trips a single-signer message', () => {
    const message = new Uint8Array([0x80, 0x01, 0x02, 0x03, 0x04]); // v0 marker + arbitrary
    const sig = new Uint8Array(64).fill(0x42);
    const wire = reassembleTransaction([sig], message);
    const parsed = parseTransaction(wire);
    expect(parsed.numSignatures).toBe(1);
    expect(Array.from(parsed.signatures[0]!)).toEqual(Array.from(sig));
    expect(Array.from(parsed.message)).toEqual(Array.from(message));
  });

  it('round-trips multi-signer (3 sigs)', () => {
    const message = new Uint8Array([0xff, 0xee, 0xdd]);
    const sigs = [
      new Uint8Array(64).fill(1),
      new Uint8Array(64).fill(2),
      new Uint8Array(64).fill(3),
    ];
    const wire = reassembleTransaction(sigs, message);
    const parsed = parseTransaction(wire);
    expect(parsed.numSignatures).toBe(3);
    expect(parsed.signatures.map((s) => Array.from(s))).toEqual(sigs.map((s) => Array.from(s)));
  });

  it('rejects signatures that aren\'t exactly 64 bytes', () => {
    const message = new Uint8Array(10);
    expect(() => reassembleTransaction([new Uint8Array(32)], message)).toThrow(/64 bytes/);
  });
});

describe('signAndSendJupiterTx', () => {
  /** Build a base64-encoded fake "Jupiter tx" with an empty signature
   *  slot and a known message body. */
  function fakeJupiterTx(message: Uint8Array): string {
    const tx = reassembleTransaction([new Uint8Array(64)], message);
    return Buffer.from(tx).toString('base64');
  }

  function mkWallet(handler: (msg: Uint8Array) => Uint8Array): WalletProvider {
    return {
      id: 'fake-sol',
      capabilities: () => ['sign-solana-message'],
      supportedChains: () => ['solana'],
      getAddress: async () => 'FakePubkey',
      signSolanaMessage: async ({ message }) => base58encode(handler(message instanceof Uint8Array ? message : new TextEncoder().encode(message))),
    };
  }

  function mkRpc(handler: (method: string, params: unknown[]) => unknown) {
    const original = globalThis.fetch;
    const calls: Array<{ method: string; params: unknown[] }> = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ method: body?.method, params: body?.params });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: handler(body?.method, body?.params) }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    return { calls, restore: () => { globalThis.fetch = original; } };
  }

  it('signs the message portion (not the whole serialized tx) and submits it', async () => {
    const message = new Uint8Array([0x80, 0xaa, 0xbb, 0xcc]);
    const expectedSig = new Uint8Array(64).fill(0x42);

    let signedMessage: Uint8Array | null = null;
    const wallet = mkWallet((msg) => {
      signedMessage = msg;
      return expectedSig;
    });
    const { calls, restore } = mkRpc(() => 'mock-signature');
    try {
      const sig = await signAndSendJupiterTx({
        swapTransactionB64: fakeJupiterTx(message),
        walletProvider: wallet,
        rpcUrl: 'http://fake',
      });
      expect(sig).toBe('mock-signature');
      expect(Array.from(signedMessage!)).toEqual(Array.from(message));
      expect(calls[0]?.method).toBe('sendTransaction');
    } finally {
      restore();
    }
  });

  it('rejects when the wallet provider lacks signSolanaMessage', async () => {
    const wallet: WalletProvider = {
      id: 'no-sol',
      capabilities: () => ['get-address'],
      supportedChains: () => ['solana'],
      getAddress: async () => 'X',
    };
    const { restore } = mkRpc(() => 'sig');
    try {
      await expect(signAndSendJupiterTx({
        swapTransactionB64: fakeJupiterTx(new Uint8Array([1])),
        walletProvider: wallet,
        rpcUrl: 'http://fake',
      })).rejects.toThrow(/signSolanaMessage/);
    } finally {
      restore();
    }
  });

  it('rejects when the wallet returns a non-64-byte signature', async () => {
    const wallet = mkWallet(() => new Uint8Array(32)); // wrong size
    const { restore } = mkRpc(() => 'sig');
    try {
      await expect(signAndSendJupiterTx({
        swapTransactionB64: fakeJupiterTx(new Uint8Array([1])),
        walletProvider: wallet,
        rpcUrl: 'http://fake',
      })).rejects.toThrow(/64 bytes/);
    } finally {
      restore();
    }
  });
});

describe('trackSolanaTransaction', () => {
  function mkRpc(statuses: Array<unknown>) {
    const original = globalThis.fetch;
    let i = 0;
    globalThis.fetch = (async () => {
      const value = statuses[Math.min(i, statuses.length - 1)];
      i++;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [value] } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    return () => { globalThis.fetch = original; };
  }

  it('returns confirmed when the signature reaches target commitment', async () => {
    const restore = mkRpc([
      null,
      null,
      { slot: 100, confirmations: 5, err: null, confirmationStatus: 'confirmed' },
    ]);
    try {
      const out = await trackSolanaTransaction({
        rpcUrl: 'http://fake', signature: 'sig',
        sleep: async () => {}, now: () => 0, pollIntervalMs: 1, timeoutMs: 1000,
      });
      expect(out.kind).toBe('confirmed');
      if (out.kind === 'confirmed') {
        expect(out.slot).toBe(100);
      }
    } finally {
      restore();
    }
  });

  it('returns reverted when the status carries an error', async () => {
    const restore = mkRpc([
      { slot: 1, confirmations: 0, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' },
    ]);
    try {
      const out = await trackSolanaTransaction({
        rpcUrl: 'http://fake', signature: 'sig',
        sleep: async () => {},
      });
      expect(out.kind).toBe('reverted');
    } finally {
      restore();
    }
  });

  it('returns timeout when the signature never confirms', async () => {
    const restore = mkRpc([null]);
    let now = 0;
    try {
      const out = await trackSolanaTransaction({
        rpcUrl: 'http://fake', signature: 'sig',
        sleep: async () => { now += 500; },
        now: () => now,
        pollIntervalMs: 500, timeoutMs: 2000,
      });
      expect(out.kind).toBe('timeout');
    } finally {
      restore();
    }
  });

  it('respects the requested commitment level (finalized requires more than confirmed)', async () => {
    const restore = mkRpc([
      { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' },
      { slot: 1, confirmations: 32, err: null, confirmationStatus: 'finalized' },
    ]);
    try {
      const out = await trackSolanaTransaction({
        rpcUrl: 'http://fake', signature: 'sig',
        commitment: 'finalized',
        sleep: async () => {}, now: () => 0,
        pollIntervalMs: 1, timeoutMs: 1000,
      });
      expect(out.kind).toBe('confirmed');
      if (out.kind === 'confirmed') {
        expect(out.commitment).toBe('finalized');
      }
    } finally {
      restore();
    }
  });
});

describe('fetchJupiterSwap', () => {
  it('POSTs the quote response + user pubkey and returns swapTransaction', async () => {
    const original = globalThis.fetch;
    let postedBody: unknown = null;
    globalThis.fetch = (async (_: unknown, init?: { body?: string }) => {
      postedBody = init?.body ? JSON.parse(init.body) : null;
      return new Response(JSON.stringify({ swapTransaction: 'BASE64TX', lastValidBlockHeight: 1234 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    try {
      const res = await fetchJupiterSwap('http://fake', {
        quoteResponse: { fake: 'quote' },
        userPublicKey: 'UserPubkey123',
      });
      expect(res.swapTransaction).toBe('BASE64TX');
      expect(res.lastValidBlockHeight).toBe(1234);
      const body = postedBody as { quoteResponse: unknown; userPublicKey: string };
      expect(body.userPublicKey).toBe('UserPubkey123');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws on non-2xx', async () => {
    const original = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (async () => new Response('bad request', { status: 400 })) as any;
    try {
      await expect(fetchJupiterSwap('http://fake', { quoteResponse: {}, userPublicKey: 'X' }))
        .rejects.toThrow(/jupiter swap 400/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
