/**
 * Alert bus — sources push events here, the UI / notifier subscribes.
 *
 * Decoupled from delivery: the bus only fans out, downstream handlers decide
 * what to do (terminal bell, push notification, persist to storage, log file).
 */

import type { Alert, AlertLevel, SourceId } from './types.js';

type Listener = (a: Alert) => void;

export class AlertBus {
  private listeners = new Set<Listener>();
  private buffer: Alert[] = [];
  private readonly maxBuffer: number;

  constructor(maxBuffer = 100) {
    this.maxBuffer = maxBuffer;
  }

  push(input: { level: AlertLevel; sourceId: SourceId; text: string; link?: string; opportunityId?: string }) {
    const alert: Alert = {
      id: `${input.sourceId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      ...input,
    };
    this.buffer.push(alert);
    while (this.buffer.length > this.maxBuffer) this.buffer.shift();
    for (const l of this.listeners) {
      try { l(alert); } catch {}
    }
    return alert;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recent(): Alert[] {
    return [...this.buffer];
  }
}
