/**
 * Shared activity log — daemon workers write here, TUI reads from Supabase.
 * Ring buffer of recent events with timestamps.
 */

interface LogEntry {
  at: string;
  text: string;
}

const MAX_ENTRIES = 100;
const buffer: LogEntry[] = [];

// Store original console.log to avoid recursion when console.log is overridden
const _origLog = console.log.bind(console);

export function logActivity(text: string) {
  buffer.push({ at: new Date().toISOString(), text });
  while (buffer.length > MAX_ENTRIES) buffer.shift();
  _origLog(text);
}

export function getActivityLog(): LogEntry[] {
  return [...buffer];
}
