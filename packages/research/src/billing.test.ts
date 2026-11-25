import { describe, expect, it } from 'vitest';
import { cardBilling, DERIVED_CARDS, isRawQuoteSource } from './billing.js';
import { registry } from './cards/index.js';

const cards = registry().allCards();

/** Titles that mean "this card shows quotes": prices, boards, charts, books, chains. */
const QUOTE_TITLE = /\b(quote|price|prices|chart|board|watchlist|indices|movers|gainers|losers|most active|order book|book|chain|spot|perpetuals|futures|listings?|across exchanges|top coins|major coins|returns|compare|sectors|etfs|stocks|miners|constituents|history)\b/i;

describe('research billing classification', () => {
  it('never meters a raw-quote card', () => {
    const offenders = cards
      .filter((c) => isRawQuoteSource(c.source) && QUOTE_TITLE.test(c.title))
      .filter((c) => cardBilling(c).metered)
      .map((c) => `${c.id} (${c.source}: ${c.title})`);
    expect(offenders).toEqual([]);
  });

  it('keeps the known quote cards free', () => {
    for (const id of [
      'overview.watchlist', 'overview.chart', 'overview.cross-asset', 'overview.normalized', 'overview.us-indices', 'equities.price-history', 'equities.gainers',
      'derivatives.options-chain', 'derivatives.crypto-spot', 'derivatives.crypto-order-book', 'derivatives.futures-board',
      'commodities.futures-board', 'crypto.price-compare', 'crypto.spot-book', 'crypto.top-coins', 'crypto.okx-perps',
    ]) {
      const c = registry().card(id);
      expect(c, id).toBeDefined();
      expect(cardBilling(c!).metered, id).toBe(false);
    }
  });

  it('meters FRED and EIA cards', () => {
    for (const c of cards.filter((x) => x.source === 'FRED' || x.source === 'EIA')) {
      const b = cardBilling(c);
      expect(b.metered, c.id).toBe(true);
      expect(b.basis).toBe(c.source === 'FRED' ? 'fred' : 'eia');
    }
  });

  it('every derived card exists and is metered as derived', () => {
    for (const id of Object.keys(DERIVED_CARDS)) {
      const c = registry().card(id);
      expect(c, id).toBeDefined();
      expect(cardBilling(c!)).toMatchObject({ metered: true, basis: 'derived' });
      expect(QUOTE_TITLE.test(c!.title) && isRawQuoteSource(c!.source), `${id} looks like a quote card`).toBe(false);
    }
  });

  it('every other card is free, and the catalog says so', () => {
    const { cards: catalog } = registry().catalog();
    for (const c of catalog) {
      const b = cardBilling(c);
      expect(c.metered, c.id).toBe(b.metered);
      if (!b.metered) expect(c.meterBasis).toBeUndefined();
    }
    const metered = catalog.filter((c) => c.metered).length;
    expect(metered).toBeGreaterThan(20);
    expect(metered).toBeLessThan(catalog.length / 3);
  });
});
