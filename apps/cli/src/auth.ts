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
import { createClient } from '@supabase/supabase-js';

const CRED_PATH = join(homedir(), '.config', 'b1dz', 'credentials.json');

export interface StoredCredentials {
  email: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  savedAt: string;
}

function publicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set in .env');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
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
  const client = publicClient();
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) { console.error('signup failed:', error.message); process.exit(1); }
  if (!data.user || !data.session) {
    console.error('signup succeeded but session missing — confirm your email and run `b1dz login`');
    process.exit(0);
  }
  saveCredentials({
    email,
    userId: data.user.id,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    savedAt: new Date().toISOString(),
  });
  console.log(`✓ signed up as ${email}`);
  console.log(`  user_id: ${data.user.id}`);
}

export async function login() {
  const email = (await prompt('Email: ')).trim();
  const password = await promptPassword('Password: ');
  const client = publicClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user || !data.session) {
    console.error('login failed:', error?.message || 'no session');
    process.exit(1);
  }
  saveCredentials({
    email,
    userId: data.user.id,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    savedAt: new Date().toISOString(),
  });
  console.log(`✓ logged in as ${email}`);
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
