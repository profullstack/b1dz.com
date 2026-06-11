/**
 * Live conformance against a real Alpaca *paper* account.
 *
 * Skipped automatically unless ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are
 * set, so CI stays hermetic. To run it:
 *
 *   ALPACA_API_KEY_ID=… ALPACA_API_SECRET_KEY=… pnpm --filter @b1dz/source-alpaca test
 *
 * This is the acceptance gate from PRD §11: link, stream a quote, place/cancel,
 * report positions and buying power — against the paper environment.
 */
import { describe } from 'vitest';
import { runBrokerConformance } from './conformance.js';
import { createAlpacaConnector } from './index.js';

const keyId = process.env.ALPACA_API_KEY_ID;
const secretKey = process.env.ALPACA_API_SECRET_KEY;
const testSymbol = process.env.ALPACA_TEST_SYMBOL ?? 'AAPL';

if (keyId && secretKey) {
  runBrokerConformance('alpaca-paper (live)', () => ({
    connector: createAlpacaConnector({ keyId, secretKey, paper: true }),
    testSymbol,
  }));
} else {
  describe.skip('alpaca-paper (live) — set ALPACA_API_KEY_ID/SECRET to run', () => {});
}
