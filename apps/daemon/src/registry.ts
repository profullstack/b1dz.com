/**
 * Source registry — every monitorable platform b1dz supports.
 *
 * Add a new entry here and the daemon will start polling it for any user
 * who has credentials in `source_state.payload.credentials`. Sources are
 * the same `Source<T>` interface from @b1dz/core, so this matches what the
 * web app and CLI already work with.
 */

import type { SourceWorker } from './types.js';
import { dealdashWorker } from './sources/dealdash.js';

export const SOURCES: SourceWorker[] = [
  dealdashWorker,
  // future:
  //   ebayWorker,
  //   amazonAuctionWorker,
  //   binanceArbWorker,
  //   krakenArbWorker,
  //   geminiArbWorker,
];
