/**
 * Dynamic pair discovery — finds the best tradeable pairs across exchanges.
 *
 * 1. Fetch all liquid USD pairs + volumes across supported exchanges
 * 2. Keep pairs that exist on at least two exchanges
 * 3. Rank by 24h volume (must exceed minimum threshold)
 * 4. Return every pair that clears the liquidity + market-cap filters
 *
 * Refreshes every 5 minutes.
 */

import { createSign, randomBytes } from 'node:crypto';
import { getCoinbasePem } from './feeds/coinbase-pem.js';
import { fetchJson } from './feeds/http.js';

const MIN_VOLUME_USD = 100_000; // $100k minimum combined 24h volume
const MIN_MARKET_CAP_USD = 10_000_000; // $10M minimum market cap
const MIN_EXCHANGES = 2;
const REFRESH_INTERVAL = 5 * 60 * 1000;

const EXCLUDED = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP', 'GUSD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY']);

let cachedPairs: string[] = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
let lastRefresh = 0;

// ─── Kraken ───────────────────────────────────────────────────

function normalizeKrakenBase(krakenName: string): string | null {
  let base = krakenName.replace(/ZUSD$/, '').replace(/USD$/, '');
  if (base.startsWith('XX')) base = base.slice(2);
  else if (base.startsWith('X') && base.length > 3) base = base.slice(1);
  else if (base.startsWith('Z')) base = base.slice(1);
  if (base === 'XBT') base = 'BTC';
  if (base === 'XDG') base = 'DOGE';
  if (EXCLUDED.has(base)) return null;
  if (base.length === 0) return null;
  return base;
}

async function getKrakenVolumes(): Promise<Map<string, number>> {
  const res = await fetch('https://api.kraken.com/0/public/Ticker');
  if (!res.ok) throw new Error(`Kraken ticker: ${res.status}`);
  const data = (await res.json()) as { error: string[]; result: Record<string, { v: [string, string]; c: [string, string] }> };
  if (data.error?.length) throw new Error(data.error.join(', '));

  const volumes = new Map<string, number>();
  for (const [name, ticker] of Object.entries(data.result)) {
    if (!name.endsWith('USD') && !name.endsWith('ZUSD')) continue;
    const base = normalizeKrakenBase(name);
    if (!base) continue;
    const pair = `${base}-USD`;
    const vol24h = parseFloat(ticker.v[1]);
    const lastPrice = parseFloat(ticker.c[0]);
    const volUsd = vol24h * lastPrice;
    if (volUsd < MIN_VOLUME_USD) continue;
    const existing = volumes.get(pair) ?? 0;
    if (volUsd > existing) volumes.set(pair, volUsd);
  }
  return volumes;
}

// ─── Coinbase ─────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getCoinbaseVolumes(): Promise<Map<string, { volUsd: number; change24h: number }>> {
  const keyName = process.env.COINBASE_API_KEY_NAME;
  const pem = getCoinbasePem();
  if (!keyName || !pem) return new Map();
  const path = '/api/v3/brokerage/products';
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString('hex');
  const header = { alg: 'ES256', kid: keyName, nonce, typ: 'JWT' };
  const payload = { sub: keyName, iss: 'cdp', aud: ['cdp_service'], nbf: now, exp: now + 120, uris: [`GET api.coinbase.com${path}`] };
  const segs = [base64url(Buffer.from(JSON.stringify(header))), base64url(Buffer.from(JSON.stringify(payload)))];
  const input = segs.join('.');
  const sign = createSign('SHA256');
  sign.update(input);
  const jwt = input + '.' + base64url(sign.sign({ key: pem, dsaEncoding: 'ieee-p1363' }));

  const res = await fetch(`https://api.coinbase.com${path}?product_type=SPOT&limit=250`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) return new Map();
  const data = (await res.json()) as { products: { product_id: string; quote_currency_id: string; base_currency_id: string; volume_24h: string; price: string; price_percentage_change_24h: string }[] };

  const result = new Map<string, { volUsd: number; change24h: number }>();
  for (const p of data.products) {
    if (p.quote_currency_id !== 'USD') continue;
    if (EXCLUDED.has(p.base_currency_id)) continue;
    const vol = parseFloat(p.volume_24h);
    const price = parseFloat(p.price);
    const volUsd = vol * price;
    if (volUsd < MIN_VOLUME_USD) continue;
    result.set(p.product_id, { volUsd, change24h: parseFloat(p.price_percentage_change_24h || '0') });
  }
  return result;
}

// ─── Binance.US ───────────────────────────────────────────────

interface Binance24hTicker {
  symbol: string;
  quoteVolume: string;
  lastPrice: string;
  priceChangePercent: string;
}

async function getBinanceVolumes(): Promise<Map<string, { volUsd: number; change24h: number }>> {
  const data = await fetchJson<Binance24hTicker[]>('https://api.binance.us/api/v3/ticker/24hr');
  const result = new Map<string, { volUsd: number; change24h: number }>();
  for (const ticker of data) {
    if (!ticker.symbol.endsWith('USD')) continue;
    const base = ticker.symbol.slice(0, -3).toUpperCase();
    if (EXCLUDED.has(base)) continue;
    const pair = `${base}-USD`;
    const volUsd = parseFloat(ticker.quoteVolume);
    if (!isFinite(volUsd) || volUsd < MIN_VOLUME_USD) continue;
    result.set(pair, {
      volUsd,
      change24h: parseFloat(ticker.priceChangePercent || '0'),
    });
  }
  return result;
}

// ─── Discovery ────────────────────────────────────────────────

async function discoverPairs(): Promise<string[]> {
  const [krakenVols, coinbaseData, binanceData] = await Promise.all([
    getKrakenVolumes(),
    getCoinbaseVolumes(),
    getBinanceVolumes(),
  ]);

  // Fetch market caps from CoinGecko (top 250 coins)
  const marketCaps = new Map<string, number>();
  try {
    for (let page = 1; page <= 2; page++) {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`,
      );
      if (!res.ok) break;
      const coins = (await res.json()) as { symbol: string; market_cap: number }[];
      for (const c of coins) {
        marketCaps.set(`${c.symbol.toUpperCase()}-USD`, c.market_cap ?? 0);
      }
    }
    console.log(`[discovery] fetched market caps for ${marketCaps.size} coins`);
  } catch (e) {
    console.error(`[discovery] coingecko error (skipping mcap filter): ${(e as Error).message}`);
  }

  // Find pairs on ANY exchange with sufficient volume, prefer pairs on multiple
  const allPairs = new Map<string, { totalVol: number; change: number; mcap: number; exchanges: number }>();
  for (const [pair, vol] of krakenVols) {
    const existing = allPairs.get(pair);
    if (existing) { existing.totalVol += vol; existing.exchanges++; }
    else allPairs.set(pair, { totalVol: vol, change: 0, mcap: 0, exchanges: 1 });
  }
  for (const [pair, data] of coinbaseData) {
    const existing = allPairs.get(pair);
    if (existing) { existing.totalVol += data.volUsd; existing.change = data.change24h; existing.exchanges++; }
    else allPairs.set(pair, { totalVol: data.volUsd, change: data.change24h, mcap: 0, exchanges: 1 });
  }
  for (const [pair, data] of binanceData) {
    const existing = allPairs.get(pair);
    if (existing) { existing.totalVol += data.volUsd; existing.change = existing.change || data.change24h; existing.exchanges++; }
    else allPairs.set(pair, { totalVol: data.volUsd, change: data.change24h, mcap: 0, exchanges: 1 });
  }

  const common: { pair: string; totalVol: number; change: number; mcap: number }[] = [];
  let filteredMcap = 0;
  let filteredExchanges = 0;
  for (const [pair, data] of allPairs) {
    if (data.exchanges < MIN_EXCHANGES) {
      filteredExchanges++;
      continue;
    }
    const mcap = marketCaps.get(pair) ?? 0;
    data.mcap = mcap;
    if (marketCaps.size > 0 && mcap > 0 && mcap < MIN_MARKET_CAP_USD) {
      filteredMcap++;
      continue;
    }
    common.push({ pair, totalVol: data.totalVol, change: data.change, mcap });
  }

  // Sort by volume and scan every pair that clears the filters.
  common.sort((a, b) => b.totalVol - a.totalVol);
  const selected = common;

  if (selected.length > 0) {
    console.log(`[discovery] ${selected.length} pairs (${filteredExchanges} filtered by <${MIN_EXCHANGES} exchanges, ${filteredMcap} filtered by <$${MIN_MARKET_CAP_USD / 1e6}M mcap, min vol $${(MIN_VOLUME_USD / 1e6).toFixed(1)}M), scanning all:`);
    for (const p of selected.slice(0, 12)) {
      const chg = p.change >= 0 ? `+${p.change.toFixed(1)}%` : `${p.change.toFixed(1)}%`;
      const mcapStr = p.mcap > 0 ? `mcap=$${(p.mcap / 1e9).toFixed(1)}B` : 'mcap=?';
      console.log(`  ${p.pair.padEnd(12)} vol=$${(p.totalVol / 1e6).toFixed(1)}M  24h=${chg}  ${mcapStr}`);
    }
    if (selected.length > 12) console.log(`  ... +${selected.length - 12} more`);
  }

  return selected.map((p) => p.pair);
}

/**
 * Get the current list of pairs to scan. Refreshes every 5 minutes.
 */
export async function getActivePairs(): Promise<string[]> {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL) {
    lastRefresh = Date.now();
    try {
      const pairs = await discoverPairs();
      if (pairs.length > 0) cachedPairs = pairs;
    } catch (e) {
      console.error(`[discovery] error: ${(e as Error).message}`);
    }
  }
  return cachedPairs;
}
