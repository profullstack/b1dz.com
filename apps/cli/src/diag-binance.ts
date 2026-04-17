/**
 * b1dz diag-binance — print the Binance.US balance breakdown the arb
 * sizer actually sees vs. what's spendable, plus any open orders.
 *
 * Usage: pnpm --filter @b1dz/cli exec tsx src/diag-binance.ts
 */
import { createHmac } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env') });

const BASE = 'https://api.binance.us';

function getKeys() {
  const key = process.env.BINANCE_US_API_KEY;
  const secret = process.env.BINANCE_US_API_SECRET;
  if (!key || !secret) throw new Error('BINANCE_US_API_KEY / BINANCE_US_API_SECRET missing');
  return { key, secret };
}

function sign(qs: string, secret: string) {
  return createHmac('sha256', secret).update(qs).digest('hex');
}

async function binanceGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const { key, secret } = getKeys();
  const p = { ...params, timestamp: Date.now().toString(), recvWindow: '15000' };
  const qs = new URLSearchParams(p).toString();
  const url = `${BASE}${path}?${qs}&signature=${sign(qs, secret)}`;
  const res = await fetch(url, { headers: { 'X-MBX-APIKEY': key } });
  const data = await res.json();
  if (!res.ok || (data as { code?: number }).code) {
    throw new Error(`${path}: ${JSON.stringify(data)}`);
  }
  return data as T;
}

interface Balance { asset: string; free: string; locked: string }
interface Account { balances: Balance[] }
interface OpenOrder {
  symbol: string; orderId: number; side: string; type: string;
  price: string; origQty: string; executedQty: string; status: string;
}

async function main() {
  console.log('── Binance.US balances (free vs locked) ──');
  const acct = await binanceGet<Account>('/api/v3/account');
  const stables = ['USD', 'USDT', 'USDC'];
  let stableFree = 0, stableLocked = 0;
  const rows: Array<[string, string, string]> = [];
  for (const b of acct.balances) {
    const free = parseFloat(b.free), locked = parseFloat(b.locked);
    if (free + locked <= 0) continue;
    rows.push([b.asset, free.toFixed(8), locked.toFixed(8)]);
    if (stables.includes(b.asset)) { stableFree += free; stableLocked += locked }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  console.log('asset      free               locked');
  for (const [a, f, l] of rows) console.log(`${a.padEnd(10)} ${f.padEnd(18)} ${l}`);

  console.log('');
  console.log('── Stable-asset summary ──');
  console.log(`USD+USDT+USDC free:   $${stableFree.toFixed(2)}`);
  console.log(`USD+USDT+USDC locked: $${stableLocked.toFixed(2)}`);
  console.log(`Total (what quoteBalance sees): $${(stableFree + stableLocked).toFixed(2)}`);

  console.log('');
  console.log('── Open orders (lock funds) ──');
  const open = await binanceGet<OpenOrder[]>('/api/v3/openOrders');
  if (open.length === 0) {
    console.log('(none)');
  } else {
    for (const o of open) {
      const remaining = parseFloat(o.origQty) - parseFloat(o.executedQty);
      const notional = remaining * parseFloat(o.price);
      console.log(`${o.symbol} ${o.side} ${o.type} qty=${o.origQty} price=${o.price} notional≈$${notional.toFixed(2)} status=${o.status}`);
    }
  }

  console.log('');
  console.log('── Diagnosis ──');
  const usdFree = parseFloat(acct.balances.find((b) => b.asset === 'USD')?.free ?? '0');
  const usdtFree = parseFloat(acct.balances.find((b) => b.asset === 'USDT')?.free ?? '0');
  const usdcFree = parseFloat(acct.balances.find((b) => b.asset === 'USDC')?.free ?? '0');
  console.log(`USD  free only: $${usdFree.toFixed(2)}   ← BTCUSD orders can only spend this`);
  console.log(`USDT free only: $${usdtFree.toFixed(2)}`);
  console.log(`USDC free only: $${usdcFree.toFixed(2)}`);
  if (stableFree + stableLocked > usdFree + 0.01) {
    console.log('');
    console.log('⚠  Arb sizer sums all stables and includes locked — but orders target BTCUSD');
    console.log('   and only USD.free is actually spendable.');
  }
}

main().catch((e) => { console.error(e); process.exit(1) });
