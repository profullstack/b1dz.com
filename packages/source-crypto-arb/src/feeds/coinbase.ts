import type { PriceFeed, MarketSnapshot, OrderBook } from '@b1dz/core';
import { createSign, randomBytes } from 'node:crypto';

const BASE = 'https://api.coinbase.com';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildJwt(method: string, path: string): string | null {
  const keyName = process.env.COINBASE_API_KEY_NAME;
  const privateKey = process.env.COINBASE_API_PRIVATE_KEY;
  if (!keyName || !privateKey) return null;
  const pem = privateKey.replace(/\\n/g, '\n');

  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString('hex');
  const uri = `${method} api.coinbase.com${path.split('?')[0]}`;

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

async function coinbaseFetch<T>(path: string): Promise<T> {
  const jwt = buildJwt('GET', path);
  const headers: Record<string, string> = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`Coinbase ${path}: ${res.status}`);
  return (await res.json()) as T;
}

interface CoinbaseBestBidAsk {
  pricebooks: {
    product_id: string;
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
  }[];
}

interface CoinbaseOrderBook {
  pricebook: {
    product_id: string;
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
  };
}

export class CoinbaseFeed implements PriceFeed {
  exchange = 'coinbase';

  async snapshot(pair: string): Promise<MarketSnapshot | null> {
    try {
      const data = await coinbaseFetch<CoinbaseBestBidAsk>(
        `/api/v3/brokerage/best_bid_ask?product_ids=${pair}`,
      );
      const book = data.pricebooks?.[0];
      if (!book || !book.bids.length || !book.asks.length) return null;
      return {
        exchange: this.exchange,
        pair,
        bid: parseFloat(book.bids[0].price),
        ask: parseFloat(book.asks[0].price),
        bidSize: parseFloat(book.bids[0].size),
        askSize: parseFloat(book.asks[0].size),
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async orderBook(pair: string, depth = 10): Promise<OrderBook | null> {
    try {
      const data = await coinbaseFetch<CoinbaseOrderBook>(
        `/api/v3/brokerage/product_book?product_id=${pair}&limit=${depth}`,
      );
      const book = data.pricebook;
      if (!book) return null;
      return {
        exchange: this.exchange,
        pair,
        bids: book.bids.map((e) => ({ price: parseFloat(e.price), size: parseFloat(e.size) })),
        asks: book.asks.map((e) => ({ price: parseFloat(e.price), size: parseFloat(e.size) })),
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }
}
