/**
 * Run the shared broker conformance suite against the in-memory FakeBroker.
 * This is the CI gate: it proves the suite passes with no network/credentials.
 * The same suite runs against live Alpaca paper in alpaca-live.test.ts when
 * ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are present.
 */
import { runBrokerConformance } from './conformance.js';
import { FakeBroker } from './fake-broker.js';

runBrokerConformance('fake-broker', () => ({
  connector: new FakeBroker({
    quotes: { AAPL: { bid: 199.9, ask: 200.1, last: 200, ts: Date.now() } },
    positions: [
      { symbol: 'AAPL', qty: 10, avgEntry: 180, marketValue: 2000, currency: 'USD', exchange: 'NASDAQ' },
    ],
  }),
  testSymbol: 'AAPL',
}));
