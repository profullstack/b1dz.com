/**
 * Loopback control endpoint for unlock sessions.
 *
 *   POST /unlock { userId, dataKey (base64 32 bytes), ttlSeconds? }
 *   POST /lock   { userId }
 *   POST /status { userId }
 *   GET  /health
 *
 * Bound to 127.0.0.1 (B1DZ_DAEMON_CONTROL_HOST/PORT, default :8790) and
 * gated by B1DZ_DAEMON_CONTROL_TOKEN (x-b1dz-control-token). The web app is
 * the only caller: it authenticates the user and forwards the data key. The
 * key is verified against the user's key-check value, copied into the
 * in-memory UnlockStore, and the request buffer is zeroed. Request bodies and
 * keys are never logged. Without a token the server does not start, so every
 * sealed user stays locked (safe default).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { clampUnlockTtlSeconds } from '@b1dz/core/sealed-secrets';
import type { UnlockStore } from './unlock-store.js';

const MAX_BODY = 4096;

export interface ControlServerOptions {
  store: UnlockStore;
  token: string;
  /** Verify a candidate data key for a user (seal.key_check). */
  verifyKey: (userId: string, key: Uint8Array) => Promise<'ok' | 'no-seal' | 'bad-key'>;
  /** Called after unlock/lock so cached state is refreshed. */
  onChange?: (userId: string) => void;
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function tokenOk(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const c = chunk as Buffer;
    size += c.length;
    if (size > MAX_BODY) {
      for (const x of chunks) x.fill(0);
      return null;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks);
  for (const x of chunks) x.fill(0);
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    raw.fill(0);
  }
}

export function createControlHandler(opts: ControlServerOptions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (!tokenOk(req.headers['x-b1dz-control-token'], opts.token)) return send(res, 401, { error: 'unauthorized' });

      const body = await readJson(req);
      if (!body) return send(res, 400, { error: 'bad body' });
      const userId = typeof body.userId === 'string' ? body.userId : '';
      if (!UUIDISH.test(userId)) return send(res, 400, { error: 'userId required' });

      switch (req.url) {
        case '/status':
          return send(res, 200, opts.store.status(userId));
        case '/lock':
          opts.store.lock(userId);
          opts.onChange?.(userId);
          console.log(`b1dzd: trading session locked ${userId.slice(0, 8)}…`);
          return send(res, 200, opts.store.status(userId));
        case '/unlock': {
          const b64 = typeof body.dataKey === 'string' ? body.dataKey : '';
          body.dataKey = undefined;
          const key = new Uint8Array(Buffer.from(b64, 'base64'));
          try {
            if (key.length !== 32) return send(res, 400, { error: 'dataKey must be 32 bytes' });
            const verdict = await opts.verifyKey(userId, key);
            if (verdict === 'no-seal') return send(res, 409, { error: 'no passphrase set for this account' });
            if (verdict !== 'ok') return send(res, 403, { error: 'wrong key' });
            const status = opts.store.unlock(userId, key, clampUnlockTtlSeconds(body.ttlSeconds));
            opts.onChange?.(userId);
            console.log(`b1dzd: trading session unlocked ${userId.slice(0, 8)}… until ${status.expiresAt}`);
            return send(res, 200, status);
          } finally {
            key.fill(0);
          }
        }
        default:
          return send(res, 404, { error: 'not found' });
      }
    } catch {
      // Never echo the error: it could carry request data.
      return send(res, 500, { error: 'internal error' });
    }
  };
}

export function startControlServer(opts: Omit<ControlServerOptions, 'token'> & { token?: string; host?: string; port?: number }): Server | null {
  const token = opts.token ?? process.env.B1DZ_DAEMON_CONTROL_TOKEN ?? '';
  if (token.length < 24) {
    console.error('b1dzd: B1DZ_DAEMON_CONTROL_TOKEN missing or short — unlock endpoint NOT started; sealed users stay locked');
    return null;
  }
  const host = opts.host ?? process.env.B1DZ_DAEMON_CONTROL_HOST ?? '127.0.0.1';
  const port = opts.port ?? Number.parseInt(process.env.B1DZ_DAEMON_CONTROL_PORT ?? '8790', 10);
  const server = createServer(createControlHandler({ ...opts, token }));
  server.on('error', (e) => console.error(`b1dzd: control server error: ${(e as Error).message}`));
  server.listen(port, host, () => console.log(`b1dzd: unlock control endpoint on ${host}:${port}`));
  return server;
}
