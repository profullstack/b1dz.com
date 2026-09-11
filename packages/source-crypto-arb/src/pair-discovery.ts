/**
 * Dynamic pair discovery — finds the best tradeable pairs across exchanges.
 *
 * 1. Fetch all liquid USD pairs + volumes across supported exchanges
 * 2. Keep pairs that exist on at least two exchanges
 * 3. Rank by 24h volume (must exceed minimum threshold)
 * 4. Return every pair that clears the liquidity + market-cap filters
 *
 * Refreshes every 5 minutes.
 *
 * With NICHEDB_CRYPTO=1 the universe (per-venue tickers and CoinGecko market
 * caps) is read from nichedb.dev in ~10 requests instead of CoinGecko plus the
 * four venues' ticker lists; the filters are the same. Any nichedb failure or
 * an empty answer falls back to the live path below, logged once per outage.
 */

import { createSign, randomBytes } from 'node:crypto';
import {
  createNichedbClient,
  fetchCryptoAssets,
  fetchCryptoPairs,
  nichedbEnabled,
  selectCryptoPairs,
  type CryptoAssetItem,
  type DiscoveredPair,
  type FetchLike,
} from '@b1dz/source-nichedb';
import { getCoinbasePem } from './feeds/coinbase-pem.js';
import { fetchJson } from './feeds/http.js';

/** Per-exchange 24h USD volume floor. A pair listed on a venue with volume
 *  under this is treated as "not really traded there" and excluded from
 *  that venue's map. Default $50k — strict enough to skip truly thin books,
 *  loose enough that mid-caps on Kraken/Coinbase actually qualify.
 *  Override via MIN_VOLUME_USD env. */
const DEFAULT_MIN_VOLUME_USD = 50_000;
function minVolumeUsd(): number {
  const v = Number.parseFloat(process.env.MIN_VOLUME_USD ?? String(DEFAULT_MIN_VOLUME_USD));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MIN_VOLUME_USD;
}
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
    if (volUsd < minVolumeUsd()) continue;
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
    if (volUsd < minVolumeUsd()) continue;
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
    if (!isFinite(volUsd) || volUsd < minVolumeUsd()) continue;
    result.set(pair, {
      volUsd,
      change24h: parseFloat(ticker.priceChangePercent || '0'),
    });
  }
  return result;
}

// ─── nichedb ──────────────────────────────────────────────────

let nichedbFallbackWarned = false;

/**
 * The universe from nichedb.dev's `crypto` collection: every stable-quoted
 * spot pair on the four venues (7-8 pages of 200) plus the top 500 assets by
 * market cap (3 pages). Grouped by base and filtered with the same rules as
 * the venue path: USD books only, `volume24hQuote >= MIN_VOLUME_USD` per venue
 * (a null volume, which is every Gemini book, passes, exactly as the old
 * Gemini sentinel did), on at least two venues, market cap >= $10M when known.
 *
 * Throws on a nichedb failure or an empty pair set so the caller can fall
 * back; a failed asset read only drops the market-cap filter, as a CoinGecko
 * failure did.
 */
export async function discoverPairsFromNichedb(fetchImpl?: FetchLike): Promise<DiscoveredPair[]> {
  const client = createNichedbClient({ fetch: fetchImpl });
  const [pairsResult, assetsResult] = await Promise.allSettled([fetchCryptoPairs(client), fetchCryptoAssets(client)]);
  // No pairs means no universe: throw so the caller falls back (an asset error alongside is the same outage).
  if (pairsResult.status === 'rejected') throw pairsResult.reason;
  const pairRows = pairsResult.value;
  if (pairRows.length === 0) throw new Error('nichedb returned no pairs');
  let assetRows: CryptoAssetItem[] = [];
  if (assetsResult.status === 'fulfilled') assetRows = assetsResult.value;
  else console.error(`[discovery] nichedb assets error (skipping mcap filter): ${(assetsResult.reason as Error).message}`);

  const sel = selectCryptoPairs(pairRows, assetRows, {
    minVolumeUsd: minVolumeUsd(),
    minMarketCapUsd: MIN_MARKET_CAP_USD,
    minVenues: MIN_EXCHANGES,
    excludedBases: EXCLUDED,
    quote: 'USD',
  });
  if (sel.pairs.length === 0) throw new Error(`nichedb: no pair cleared the filters (${pairRows.length} rows)`);

  console.log(
    `[discovery] nichedb: ${sel.pairs.length} pairs from ${pairRows.length} pair rows + ${assetRows.length} assets in ${client.requestCount} requests ` +
      `(${sel.filteredByVenues} filtered by <${MIN_EXCHANGES} exchanges, ${sel.filteredByMarketCap} filtered by <$${MIN_MARKET_CAP_USD / 1e6}M mcap, min vol $${(minVolumeUsd() / 1e6).toFixed(2)}M)`,
  );
  for (const p of sel.pairs.slice(0, 12)) {
    const chg = p.change24hPct >= 0 ? `+${p.change24hPct.toFixed(1)}%` : `${p.change24hPct.toFixed(1)}%`;
    const mcapStr = p.marketCapUsd > 0 ? `mcap=$${(p.marketCapUsd / 1e9).toFixed(1)}B` : 'mcap=?';
    console.log(`  ${p.pair.padEnd(12)} vol=$${(p.totalVolumeUsd / 1e6).toFixed(1)}M  24h=${chg}  ${mcapStr}  venues=${Object.keys(p.venues).join(',')}`);
  }
  if (sel.pairs.length > 12) console.log(`  ... +${sel.pairs.length - 12} more`);
  return sel.pairs;
}

// ─── Discovery ────────────────────────────────────────────────

async function discoverPairs(): Promise<string[]> {
  if (nichedbEnabled('NICHEDB_CRYPTO')) {
    try {
      const pairs = await discoverPairsFromNichedb();
      nichedbFallbackWarned = false;
      return pairs.map((p) => p.pair);
    } catch (e) {
      if (!nichedbFallbackWarned) {
        nichedbFallbackWarned = true;
        console.error(`[discovery] nichedb unavailable (${(e as Error).message}); falling back to CoinGecko + venue tickers`);
      }
    }
  }
  return discoverPairsFromVenues();
}

/** The live path: CoinGecko (2 pages x 250) plus Kraken, Coinbase and Binance.US tickers. */
async function discoverPairsFromVenues(): Promise<string[]> {
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
    console.log(`[discovery] ${selected.length} pairs (${filteredExchanges} filtered by <${MIN_EXCHANGES} exchanges, ${filteredMcap} filtered by <$${MIN_MARKET_CAP_USD / 1e6}M mcap, min vol $${(minVolumeUsd() / 1e6).toFixed(2)}M), scanning all:`);
    for (const p of selected.slice(0, 12)) {
      const chg = p.change >= 0 ? `+${p.change.toFixed(1)}%` : `${p.change.toFixed(1)}%`;
      const mcapStr = p.mcap > 0 ? `mcap=$${(p.mcap / 1e9).toFixed(1)}B` : 'mcap=?';
      console.log(`  ${p.pair.padEnd(12)} vol=$${(p.totalVol / 1e6).toFixed(1)}M  24h=${chg}  ${mcapStr}`);
    }
    if (selected.length > 12) console.log(`  ... +${selected.length - 12} more`);
  }

  return selected.map((p) => p.pair);
}

/** Gemini doesn't offer an all-tickers endpoint. We fetch its SYMBOLS list
 *  (pairs available), use `/v1/pricefeed` for a price/volume snapshot, and
 *  treat pairs present there as "live" — honest-enough proxy for our filter. */
async function getGeminiVolumes(): Promise<Map<string, number>> {
  try {
    const res = await fetch('https://api.gemini.com/v1/pricefeed');
    if (!res.ok) return new Map();
    const data = (await res.json()) as Array<{ pair: string; price: string; percentChange24h: string }>;
    const out = new Map<string, number>();
    for (const row of data) {
      if (!row.pair?.endsWith('USD')) continue;
      const base = row.pair.slice(0, -3).toUpperCase();
      if (EXCLUDED.has(base)) continue;
      // pricefeed doesn't include 24h USD volume; use a sentinel above the
      // filter threshold so Gemini pairs are accepted (we have no better
      // signal). Downstream filters (candle freshness, directional bias)
      // still guard against stale/phantom quotes.
      out.set(`${base}-USD`, minVolumeUsd() * 2);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Per-exchange 24h volume snapshot. Used by the observer/audit tools to
 * filter out pairs that aren't actively traded on a given venue — a pair
 * listed on Kraken with $5M volume but only $2k on Binance.US will
 * produce phantom arb opportunities from stale Binance.US quotes.
 *
 * Returns Map<pair, volumeUsd>. Missing pair on exchange → pair is not
 * traded there (or below the MIN_VOLUME_USD dust threshold).
 */
export async function getPerExchangeVolumes(): Promise<{
  kraken: Map<string, number>;
  coinbase: Map<string, number>;
  'binance-us': Map<string, number>;
  gemini: Map<string, number>;
}> {
  const [kraken, coinbase, binance, gemini] = await Promise.all([
    getKrakenVolumes().catch(() => new Map<string, number>()),
    getCoinbaseVolumes().catch(() => new Map<string, { volUsd: number }>()),
    getBinanceVolumes().catch(() => new Map<string, { volUsd: number }>()),
    getGeminiVolumes(),
  ]);
  return {
    kraken,
    coinbase: new Map([...coinbase].map(([p, v]) => [p, v.volUsd])),
    'binance-us': new Map([...binance].map(([p, v]) => [p, v.volUsd])),
    gemini,
  };
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
