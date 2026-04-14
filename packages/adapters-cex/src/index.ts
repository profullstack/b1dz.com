import { KrakenFeed, CoinbaseFeed, BinanceUsFeed, GeminiFeed } from '@b1dz/source-crypto-arb';
import { CexAdapter } from './cex-adapter.js';

export { CexAdapter, CEX_TAKER_FEES, type CexAdapterOptions } from './cex-adapter.js';

/** Factory helpers for the 4 CEXs wrapped into VenueAdapters. */
export function makeKrakenAdapter() { return new CexAdapter(new KrakenFeed()); }
export function makeCoinbaseAdapter() { return new CexAdapter(new CoinbaseFeed()); }
export function makeBinanceUsAdapter() { return new CexAdapter(new BinanceUsFeed()); }
export function makeGeminiAdapter() { return new CexAdapter(new GeminiFeed()); }

/** All four CEX adapters enabled for the observer by default. */
export function defaultCexAdapters(): CexAdapter[] {
  return [
    makeKrakenAdapter(),
    makeCoinbaseAdapter(),
    makeBinanceUsAdapter(),
    makeGeminiAdapter(),
  ];
}
