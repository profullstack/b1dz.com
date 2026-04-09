/**
 * Wins normalizer tests. The orders feed mixes "Auction win" and bid
 * exchange rows together — getMyWins flattens them into a single shape.
 */

import { describe, it, expect } from 'vitest';
import { getMyWins } from './wins.js';
import { stubFetcher } from './fetcher.js';

const ORDERS_FIXTURE = {
  data: [
    {
      type: 'Auction win',
      title: 'Bose Headphones',
      auctionId: '16342411',
      price: 0.25,
      timestamp: 1775637000,
      ffid: 'A44847767',
      isExchanged: false,
    },
    {
      type: '',
      title: 'Exchanged for bids: Veho STIX II True Wireless Earphones',
      auctionId: '16345520',
      price: 0,
      timestamp: 1775637401,
      bids: 300,
    },
    // Non-auction noise that should be filtered out
    {
      type: 'Reward',
      title: 'Daily login bonus',
      auctionId: null,
      price: 0,
      timestamp: 1775637500,
    },
  ],
};

describe('getMyWins', () => {
  it('returns Auction win + exchange rows, drops noise', async () => {
    const fetcher = stubFetcher(() => new Response(JSON.stringify(ORDERS_FIXTURE), { status: 200 }));
    const wins = await getMyWins(fetcher);
    expect(wins).toHaveLength(2);

    const winRow = wins.find(w => w.id === 16342411);
    expect(winRow).toBeDefined();
    expect(winRow!.exchanged).toBe(false);
    expect(winRow!.exchangedBids).toBe(0);
    expect(winRow!.orderId).toBe('44847767'); // ffid sans leading "A"

    const exchangeRow = wins.find(w => w.id === 16345520);
    expect(exchangeRow).toBeDefined();
    expect(exchangeRow!.exchanged).toBe(true);
    expect(exchangeRow!.exchangedBids).toBe(300);
    // The "Exchanged for bids: " prefix gets stripped
    expect(exchangeRow!.title).toBe('Veho STIX II True Wireless Earphones');
  });

  it('returns empty array on a network failure', async () => {
    const fetcher = stubFetcher(() => new Response('', { status: 500 }));
    expect(await getMyWins(fetcher)).toEqual([]);
  });

  it('returns empty array on malformed JSON', async () => {
    const fetcher = stubFetcher(() => new Response('not json', { status: 200 }));
    expect(await getMyWins(fetcher)).toEqual([]);
  });
});
