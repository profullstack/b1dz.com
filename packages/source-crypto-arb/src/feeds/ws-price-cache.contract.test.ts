import { afterEach, describe, expect, it } from 'vitest';
import {
  __getWsCacheStateForTests,
  __releaseWsPairsForTests,
  __resetWsCacheForTests,
  __retainWsPairsForTests,
} from './ws-price-cache.js';

describe('ws price cache subscription contract', () => {
  afterEach(() => {
    __resetWsCacheForTests();
  });

  it('reference-counts pair subscriptions and releases them cleanly', () => {
    expect(__retainWsPairsForTests(['BTC-USD', 'ETH-USD'])).toEqual(['BTC-USD', 'ETH-USD']);
    expect(__retainWsPairsForTests(['BTC-USD'])).toEqual([]);

    expect(__getWsCacheStateForTests()).toEqual({
      cacheSize: 0,
      subscribedPairs: ['BTC-USD', 'ETH-USD'],
      subscriptionRefs: [['BTC-USD', 2], ['ETH-USD', 1]],
    });

    expect(__releaseWsPairsForTests(['BTC-USD'])).toEqual([]);
    expect(__getWsCacheStateForTests().subscriptionRefs).toEqual([['BTC-USD', 1], ['ETH-USD', 1]]);

    expect(__releaseWsPairsForTests(['BTC-USD', 'ETH-USD'])).toEqual(['BTC-USD', 'ETH-USD']);
    expect(__getWsCacheStateForTests()).toEqual({
      cacheSize: 0,
      subscribedPairs: [],
      subscriptionRefs: [],
    });
  });
});
