/**
 * Source registry — every monitorable platform b1dz supports.
 *
 * Add a new entry here and the daemon will start polling it for any user
 * who has the source enabled in `source_state.payload`. Sources are
 * the same `Source<T>` interface from @b1dz/core, so this matches what the
 * web app and CLI already work with.
 */

import type { SourceWorker } from './types.js';
import { cryptoArbWorker } from './sources/crypto-arb.js';
import { cryptoTradeWorker } from './sources/crypto-trade.js';

export const SOURCES: SourceWorker[] = [
  cryptoArbWorker,
  cryptoTradeWorker,
];
