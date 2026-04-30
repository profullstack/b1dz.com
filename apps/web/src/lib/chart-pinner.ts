'use client';

import { useSyncExternalStore } from 'react';

interface PinState {
  pairA: string | null;
  exchangeA: string | null;
  pairB: string | null;
  exchangeB: string | null;
  /** Which slot the *next* pin click writes into. Flips after each pin. */
  nextSlot: 'A' | 'B';
  /** Bump on any external pin so consumers can pause auto-cycle. */
  pinSeq: number;
}

let state: PinState = {
  pairA: null,
  exchangeA: null,
  pairB: null,
  exchangeB: null,
  nextSlot: 'A',
  pinSeq: 0,
};

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): PinState {
  return state;
}

/** Pin a (pair, exchange) tuple to the next chart slot. Cycles A → B → A …
 *  If the same pair+exchange is already in either slot, no-op so re-clicks
 *  don't stomp the *other* slot. */
export function pinPair(pair: string, exchange: string | null): void {
  if (!pair) return;
  const sameA = state.pairA === pair && state.exchangeA === exchange;
  const sameB = state.pairB === pair && state.exchangeB === exchange;
  if (sameA || sameB) return;
  if (state.nextSlot === 'A') {
    state = { ...state, pairA: pair, exchangeA: exchange, nextSlot: 'B', pinSeq: state.pinSeq + 1 };
  } else {
    state = { ...state, pairB: pair, exchangeB: exchange, nextSlot: 'A', pinSeq: state.pinSeq + 1 };
  }
  emit();
}

export function useChartPin(): PinState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
