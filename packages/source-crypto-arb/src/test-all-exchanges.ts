/**
 * Integration test — run this BEFORE deploying to verify all exchanges work.
 * npx tsx packages/source-crypto-arb/src/test-all-exchanges.ts
 */
import { loadRootEnv } from '@b1dz/core';
loadRootEnv();

import { getBalance as getKrakenBalance } from './feeds/kraken-private.js';
import { getBalance as getCoinbaseBalance } from './feeds/coinbase-private.js';
import { getBalance as getBinanceBalance } from './feeds/binance-us-private.js';
import { KrakenFeed } from './feeds/kraken.js';
import { CoinbaseFeed } from './feeds/coinbase.js';
import { BinanceUsFeed } from './feeds/binance-us.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${(e as Error).message}`);
  }
}

async function main() {
  console.log('=== Exchange Integration Tests ===\n');

  console.log('Prices:');
  const k = new KrakenFeed();
  const c = new CoinbaseFeed();
  const b = new BinanceUsFeed();

  await test('Kraken BTC-USD price', async () => {
    const s = await k.snapshot('BTC-USD');
    if (!s || s.bid <= 0) throw new Error(`bad: ${JSON.stringify(s)}`);
  });
  await test('Coinbase BTC-USD price', async () => {
    const s = await c.snapshot('BTC-USD');
    if (!s || s.bid <= 0) throw new Error(`bad: ${JSON.stringify(s)}`);
  });
  await test('Binance BTC-USD price', async () => {
    const s = await b.snapshot('BTC-USD');
    if (!s || s.bid <= 0) throw new Error(`bad: ${JSON.stringify(s)}`);
  });

  console.log('\nBalances:');
  await test('Kraken balance', async () => {
    const bal = await getKrakenBalance();
    if (Object.keys(bal).length === 0) throw new Error('empty');
    console.log(`    ${JSON.stringify(bal).slice(0, 100)}`);
  });
  await test('Coinbase balance', async () => {
    const bal = await getCoinbaseBalance();
    if (Object.keys(bal).length === 0) throw new Error('empty');
    console.log(`    ${JSON.stringify(bal)}`);
  });
  await test('Binance balance', async () => {
    const bal = await getBinanceBalance();
    if (Object.keys(bal).length === 0) throw new Error('empty');
    console.log(`    ${JSON.stringify(bal)}`);
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
