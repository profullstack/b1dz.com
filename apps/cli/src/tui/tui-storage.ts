/**
 * TUI Storage adapter — returns the CLI's existing API client (from auth.ts)
 * as a @b1dz/core Storage instance that pollOnce can use.
 *
 * B1dzApiStorage already implements Storage, so this is just a convenience
 * wrapper. The daemon has its own runnerStorageFor(); the TUI uses this one.
 */

import type { Storage } from '@b1dz/core';
import { getApiClient } from '../auth.js';

export function makeTuiStorage(): Storage {
  // B1dzApiStorage implements the Storage interface directly.
  return getApiClient();
}
