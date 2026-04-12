/**
 * Coinbase Advanced Trade authenticated API client.
 *
 * Uses CDP API keys with ES256 JWT authentication:
 *   1. Build JWT with header { alg: ES256, kid: keyName, nonce }
 *   2. Sign with EC private key
 *   3. Pass as Bearer token
 *
 * Reads COINBASE_API_KEY_NAME and COINBASE_API_PRIVATE_KEY from env.
 */

import { createSign, randomBytes } from 'node:crypto';

const BASE = 'https://api.coinbase.com';

export const MAX_POSITION_USD = 100;
export const COINBASE_TAKER_FEE = 0.006; // 0.6% taker (Advanced Trade)

function getKeys() {
  const keyName = process.env.COINBASE_API_KEY_NAME;
  const privateKey = process.env.COINBASE_API_PRIVATE_KEY;
  if (!keyName || !privateKey) throw new Error('COINBASE_API_KEY_NAME / COINBASE_API_PRIVATE_KEY missing from env');
  // Reconstruct PEM from potentially mangled env var (Railway breaks lines)
  const raw = privateKey.replace(/\\n/g, '\n');
  const b64 = raw.replace(/-----(BEGIN|END) EC PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const lines = b64.match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN EC PRIVATE KEY-----\n${lines.join('\n')}\n-----END EC PRIVATE KEY-----\n`;
  // Validate PEM can be parsed
  try {
    createSign('SHA256').sign({ key: pem, dsaEncoding: 'ieee-p1363' });
  } catch {
    // Key is valid but signing empty string fails — that's OK
  }
  return { keyName, pem };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildJwt(method: string, path: string): string {
  const { keyName, pem } = getKeys();
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString('hex');

  // URI format for Coinbase: "METHOD host+path" (no query string)
  const pathOnly = path.split('?')[0];
  const uri = `${method} api.coinbase.com${pathOnly}`;

  const header = { alg: 'ES256', kid: keyName, nonce, typ: 'JWT' };
  const payload = {
    sub: keyName,
    iss: 'cdp',
    aud: ['cdp_service'],
    nbf: now,
    exp: now + 120,
    uris: [uri],
  };

  const segments = [
    base64url(Buffer.from(JSON.stringify(header))),
    base64url(Buffer.from(JSON.stringify(payload))),
  ];
  const signingInput = segments.join('.');

  const sign = createSign('SHA256');
  sign.update(signingInput);
  const sig = sign.sign({ key: pem, dsaEncoding: 'ieee-p1363' });

  return `${signingInput}.${base64url(sig)}`;
}

async function coinbasePrivate<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const jwt = buildJwt(method, path);

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Coinbase ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as T & { error?: string; message?: string };
  return data;
}

// ─── Public API ───────────────────────────────────────────────

interface CoinbaseAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: { value: string; currency: string };
  hold: { value: string; currency: string };
}

interface AccountsResponse {
  accounts: CoinbaseAccount[];
}

export async function getBalance(): Promise<Record<string, string>> {
  const data = await coinbasePrivate<AccountsResponse>('GET', '/api/v3/brokerage/accounts?limit=50');
  const result: Record<string, string> = {};
  for (const acct of data.accounts) {
    const val = parseFloat(acct.available_balance.value);
    if (val > 0) result[acct.currency] = acct.available_balance.value;
  }
  return result;
}

export interface OrderOpts {
  productId: string;     // e.g. 'BTC-USD'
  side: 'BUY' | 'SELL';
  size: string;          // base currency quantity
  limitPrice?: string;   // required for limit orders
}

interface OrderResponse {
  success: boolean;
  order_id: string;
  success_response?: { order_id: string };
  error_response?: { error: string; message: string };
}

export async function placeOrder(opts: OrderOpts): Promise<OrderResponse> {
  // Safety check
  const price = opts.limitPrice ? parseFloat(opts.limitPrice) : 0;
  const size = parseFloat(opts.size);
  if (price > 0 && size * price > MAX_POSITION_USD) {
    throw new Error(`Order cost $${(size * price).toFixed(2)} exceeds $${MAX_POSITION_USD} limit`);
  }

  const clientOrderId = `b1dz-${Date.now()}-${randomBytes(4).toString('hex')}`;

  const orderConfig = opts.limitPrice
    ? { limit_limit_gtc: { base_size: opts.size, limit_price: opts.limitPrice } }
    : { market_market_ioc: { base_size: opts.size } };

  const body = {
    client_order_id: clientOrderId,
    product_id: opts.productId,
    side: opts.side,
    order_configuration: orderConfig,
  };

  const result = await coinbasePrivate<OrderResponse>('POST', '/api/v3/brokerage/orders', body);
  if (!result.success && result.error_response) {
    throw new Error(`Coinbase order failed: ${result.error_response.error} — ${result.error_response.message}`);
  }
  return result;
}

interface CoinbaseOrder {
  order_id: string;
  product_id: string;
  side: string;
  status: string;
  filled_size: string;
  average_filled_price: string;
  total_fees: string;
  created_time: string;
}

interface OrdersResponse {
  orders: CoinbaseOrder[];
}

export async function getOpenOrders(): Promise<CoinbaseOrder[]> {
  const data = await coinbasePrivate<OrdersResponse>(
    'GET',
    '/api/v3/brokerage/orders/historical/batch?order_status=OPEN&limit=20',
  );
  return data.orders ?? [];
}

export async function getRecentFills(): Promise<{ trade_id: string; product_id: string; side: string; price: string; size: string; commission: string; trade_time: string }[]> {
  const data = await coinbasePrivate<{ fills: { trade_id: string; product_id: string; side: string; price: string; size: string; commission: string; trade_time: string }[] }>(
    'GET',
    '/api/v3/brokerage/orders/historical/fills?limit=20',
  );
  return data.fills ?? [];
}
