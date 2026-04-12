/**
 * Shared activity log — daemon workers write here, TUI reads from Supabase.
 * Ring buffer of recent events with timestamps.
 */

interface LogEntry {
  at: string;
  text: string;
}

const MAX_ENTRIES = 100;
const ACTIVITY_BUFFER_KEY = 'activity';
const RAW_BUFFER_KEY = 'raw';
const buffers = new Map<string, LogEntry[]>();
const lastTextByBuffer = new Map<string, string>();

// Store original console.log to avoid recursion when console.log is overridden
const _origLog = console.log.bind(console);

function push(kind: string, source: string, text: string) {
  const key = `${kind}:${source}`;
  if (text === lastTextByBuffer.get(key)) return;
  lastTextByBuffer.set(key, text);
  const buffer = buffers.get(key) ?? [];
  buffer.push({ at: new Date().toISOString(), text });
  while (buffer.length > MAX_ENTRIES) buffer.shift();
  buffers.set(key, buffer);
}

export function logActivity(text: string, source = 'shared') {
  // Deduplicate consecutive identical messages
  push(ACTIVITY_BUFFER_KEY, source, text);
  push(RAW_BUFFER_KEY, source, text);
  _origLog(text);
}

export function logRaw(text: string, source = 'shared') {
  push(RAW_BUFFER_KEY, source, text);
  _origLog(text);
}

export function getActivityLog(source = 'shared'): LogEntry[] {
  return [...(buffers.get(`${ACTIVITY_BUFFER_KEY}:${source}`) ?? [])];
}

export function getRawLog(source = 'shared'): LogEntry[] {
  return [...(buffers.get(`${RAW_BUFFER_KEY}:${source}`) ?? [])];
}
