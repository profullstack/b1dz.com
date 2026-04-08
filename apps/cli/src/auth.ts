/**
 * CLI auth — signup / login / session storage.
 *
 * Persists the Supabase session at `~/.config/b1dz/credentials.json` so the
 * daemon and TUI can attribute writes to the right user_id without re-prompting.
 *
 * - signup creates an auth.users row via the publishable key (public flow)
 * - login refreshes the stored session
 * - currentUser() returns { userId, accessToken } if signed in, else null
 *
 * The runner uses SUPABASE_SECRET_KEY (RLS bypass) for writes but stamps every
 * row with the locally-stored user_id so RLS still attributes correctly.
 */

import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { apiSignup, apiLogin, B1dzApiStorage } from '@b1dz/storage-b1dz-api';

const CRED_PATH = join(homedir(), '.config', 'b1dz', 'credentials.json');

export interface StoredCredentials {
  email: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  savedAt: string;
}

function apiBaseUrl(): string {
  const url = process.env.B1DZ_API_URL;
  if (!url) throw new Error('B1DZ_API_URL missing in .env');
  return url;
}

/**
 * Shared B1dzApiStorage factory with auto-persisting refresh.
 *
 * Returns a SINGLETON per process so multiple modules don't each maintain
 * their own copy of the tokens (and end up loading stale ones from disk
 * after a sibling has already refreshed). Every time the API tells us
 * the access token expired, we refresh and write the new tokens back to
 * `~/.config/b1dz/credentials.json` so the next CLI invocation also has them.
 */
let cachedApi: B1dzApiStorage | null = null;
export function getApiClient(): B1dzApiStorage {
  if (cachedApi) return cachedApi;
  const c = loadCredentials();
  if (!c) throw new Error('not signed in — run `b1dz signup` or `b1dz login`');
  cachedApi = new B1dzApiStorage({
    baseUrl: apiBaseUrl(),
    tokens: { accessToken: c.accessToken, refreshToken: c.refreshToken },
    onRefresh: (t) => {
      const updated = { ...c, accessToken: t.accessToken, refreshToken: t.refreshToken, savedAt: new Date().toISOString() };
      try {
        mkdirSync(dirname(CRED_PATH), { recursive: true });
        writeFileSync(CRED_PATH, JSON.stringify(updated, null, 2));
        chmodSync(CRED_PATH, 0o600);
      } catch {}
    },
  });
  return cachedApi;
}

function saveCredentials(c: StoredCredentials) {
  mkdirSync(dirname(CRED_PATH), { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify(c, null, 2));
  try { chmodSync(CRED_PATH, 0o600); } catch {}
}

export function loadCredentials(): StoredCredentials | null {
  if (!existsSync(CRED_PATH)) return null;
  try { return JSON.parse(readFileSync(CRED_PATH, 'utf8')); } catch { return null; }
}

export function currentUser(): { userId: string; email: string } | null {
  const c = loadCredentials();
  return c ? { userId: c.userId, email: c.email } : null;
}

async function prompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(label);
  rl.close();
  return ans;
}

/**
 * Read a password from the TTY in raw mode, echoing `*` per character.
 * Handles backspace, enter, and ctrl+c. Falls back to plain input when
 * stdin isn't a TTY (e.g. piped input in tests).
 */
export async function promptPassword(label: string): Promise<string> {
  process.stdout.write(label);
  if (!process.stdin.isTTY) {
    // Non-interactive — fall back to plain readline (no masking possible)
    return prompt('');
  }
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let buf = '';
    const onData = (input: string) => {
      for (const ch of input) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        } else if (ch === '\u0003') { // ctrl+c
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        } else if (code === 127 || code === 8) { // backspace
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (code >= 32) { // printable
          buf += ch;
          process.stdout.write('*');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function signup() {
  const email = (await prompt('Email: ')).trim();
  const password = await promptPassword('Password: ');
  try {
    const r = await apiSignup(apiBaseUrl(), email, password);
    if (!r.session) {
      console.log('Account created — confirm your email then run `b1dz login`');
      process.exit(0);
    }
    saveCredentials({
      email,
      userId: r.user.id,
      accessToken: r.session.access_token,
      refreshToken: r.session.refresh_token,
      savedAt: new Date().toISOString(),
    });
    console.log(`✓ signed up as ${email}`);
    console.log(`  user_id: ${r.user.id}`);
  } catch (e) { console.error('signup failed:', (e as Error).message); process.exit(1); }
}

export async function login() {
  const email = (await prompt('Email: ')).trim();
  const password = await promptPassword('Password: ');
  try {
    const r = await apiLogin(apiBaseUrl(), email, password);
    if (!r.session) { console.error('login returned no session'); process.exit(1); }
    saveCredentials({
      email,
      userId: r.user.id,
      accessToken: r.session.access_token,
      refreshToken: r.session.refresh_token,
      savedAt: new Date().toISOString(),
    });
    console.log(`✓ logged in as ${email}`);
  } catch (e) { console.error('login failed:', (e as Error).message); process.exit(1); }
}

export function logout() {
  if (!existsSync(CRED_PATH)) { console.log('(not signed in)'); return; }
  writeFileSync(CRED_PATH, '');
  console.log('✓ logged out');
}

export function whoami() {
  const u = currentUser();
  if (!u) { console.log('(not signed in — run `b1dz signup` or `b1dz login`)'); return; }
  console.log(`signed in as ${u.email}`);
  console.log(`user_id: ${u.userId}`);
}
