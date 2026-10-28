/**
 * CLI vault: secrets sealed under the user's passphrase (see
 * @b1dz/core/sealed-secrets). The passphrase never leaves this process; the
 * server sees ciphertext, and the daemon gets the derived data key only when
 * you run `b1dz unlock`.
 *
 * Passphrase source, in order:
 *   B1DZ_VAULT_PASSPHRASE        (non-interactive, LOGICSRC-style env)
 *   B1DZ_VAULT_PASSPHRASE_FILE   (path to a file holding it)
 *   interactive hidden prompt
 *
 *   b1dz unlock [--ttl 8h]   unlock a trading session (default 8h, max 7d)
 *   b1dz lock                lock it now; strategies pause
 *   b1dz vault status        vault + trading-session status
 *   b1dz vault passwd        change passphrase
 */
import { readFileSync } from 'node:fs';
import {
  bytesToBase64,
  createSeal,
  openInbox,
  parseTtl,
  rewrapSeal,
  sealSecrets,
  unlockSeal,
  unlockSealWithRecovery,
  unsealSecrets,
  type CipherBlob,
  type InboxEntry,
  type SealRecord,
} from '@b1dz/core/sealed-secrets';
import { loadCredentials, promptPassword } from './auth.js';

export interface SettingsResponse {
  userId: string;
  plain: Record<string, string | number | boolean | null | undefined>;
  cipher: CipherBlob | null;
  seal: SealRecord | null;
  sealVersion: 1 | 2;
  inbox: InboxEntry[];
  legacy: { pending: boolean; migrationOpen: boolean };
  lastUpdatedAt: string | null;
  cryptoConfigured: boolean;
}

export interface ApiCtx {
  accessToken: string;
  baseUrl: string;
}

export interface OpenVault {
  dek: Uint8Array;
  userId: string;
  settings: SettingsResponse;
  secrets: Record<string, string>;
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export function apiBaseUrl(): string {
  const url = process.env.B1DZ_API_URL;
  if (!url) throw new Error('B1DZ_API_URL missing in .env');
  return url;
}

export function requireCtx(): ApiCtx & { email: string | null } {
  const c = loadCredentials();
  if (!c) {
    console.error(C.red('not signed in — run `b1dz login` first'));
    process.exit(1);
  }
  return { accessToken: c.accessToken, baseUrl: apiBaseUrl(), email: c.email ?? null };
}

async function api(ctx: ApiCtx, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ctx.accessToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function json<T>(res: Response, what: string): Promise<T> {
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(`${what}: ${body.error ?? res.status}`);
  return body;
}

export async function fetchSettings(ctx: ApiCtx): Promise<SettingsResponse> {
  return json<SettingsResponse>(await api(ctx, '/api/settings'), 'fetch settings');
}

export async function putSettings(ctx: ApiCtx, body: Record<string, unknown>): Promise<SettingsResponse> {
  return json<SettingsResponse>(await api(ctx, '/api/settings', { method: 'PUT', body: JSON.stringify(body) }), 'save settings');
}

/** Passphrase from env/file/prompt. Never logged. */
export async function readPassphrase(label = 'Vault passphrase: '): Promise<string> {
  const env = process.env.B1DZ_VAULT_PASSPHRASE;
  if (env) return env;
  const file = process.env.B1DZ_VAULT_PASSPHRASE_FILE;
  if (file) return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!process.stdin.isTTY) throw new Error('no passphrase: set B1DZ_VAULT_PASSPHRASE or B1DZ_VAULT_PASSPHRASE_FILE, or run interactively');
  return promptPassword(label);
}

async function newPassphrase(): Promise<string> {
  if (process.env.B1DZ_VAULT_PASSPHRASE || process.env.B1DZ_VAULT_PASSPHRASE_FILE) return readPassphrase();
  const a = await promptPassword('New vault passphrase (10+ chars): ');
  const b = await promptPassword('Confirm passphrase: ');
  if (a !== b) throw new Error('passphrases do not match');
  return a;
}

const LOSS = 'b1dz never sees your passphrase and cannot reset it. Lose both the passphrase and the recovery key and your saved keys are gone (re-enter them).';

/**
 * Open (or, with create, set up / migrate) the vault. Merges pending OAuth
 * inbox tokens. Returns null when there is no vault and create is false.
 */
export async function openVault(ctx: ApiCtx, opts: { create?: boolean } = {}): Promise<OpenVault | null> {
  let settings = await fetchSettings(ctx);

  if (!settings.seal) {
    if (!opts.create) return null;
    const migrating = settings.legacy.pending && settings.legacy.migrationOpen;
    console.log(C.bold(migrating ? '\nMove your keys under your own passphrase' : '\nSet a vault passphrase'));
    console.log(C.dim(migrating
      ? 'Your saved keys are still encrypted with a b1dz server key. They will be re-sealed locally under a key only you hold; trading stays paused until then.'
      : 'Secrets are sealed locally under this passphrase; b1dz stores only ciphertext.'));
    console.log(C.dim(LOSS));
    const pass = await newPassphrase();
    let legacy: Record<string, string> = {};
    if (migrating) {
      legacy = (await json<{ secret?: Record<string, string> }>(await api(ctx, '/api/settings/legacy-migrate', { method: 'POST' }), 'legacy migrate')).secret ?? {};
    }
    const created = await createSeal(pass, settings.userId);
    const body: Record<string, unknown> = { seal: created.seal };
    if (Object.keys(legacy).length > 0) body.cipher = await sealSecrets(created.dek, legacy, settings.userId);
    else if (settings.legacy.pending) body.cipher = null;
    settings = await putSettings(ctx, body);
    console.log(`\n${C.bold('Recovery key (shown once, store it safely):')}\n  ${created.recoveryKey}\n`);
    return { dek: created.dek, userId: settings.userId, settings, secrets: legacy };
  }

  const useRecovery = process.env.B1DZ_VAULT_RECOVERY_KEY;
  const dek = useRecovery
    ? await unlockSealWithRecovery(settings.seal, useRecovery, settings.userId)
    : await unlockSeal(settings.seal, await readPassphrase(), settings.userId);
  let secrets = settings.cipher ? await unsealSecrets(dek, settings.cipher, settings.userId) : {};
  if (settings.inbox.length > 0) {
    const { patch, consumed } = await openInbox(dek, settings.seal, settings.inbox, settings.userId);
    if (consumed.length > 0) {
      secrets = { ...secrets, ...patch };
      settings = await putSettings(ctx, { cipher: await sealSecrets(dek, secrets, settings.userId), inboxConsumed: consumed });
      console.log(C.dim(`merged ${consumed.length} OAuth token update(s) into your vault`));
    }
  }
  return { dek, userId: settings.userId, settings, secrets };
}

export async function unlockTrading(ctx: ApiCtx, dek: Uint8Array, ttlSeconds: number): Promise<{ expiresAt: string | null }> {
  return json<{ expiresAt: string | null }>(
    await api(ctx, '/api/daemon/session', { method: 'POST', body: JSON.stringify({ dataKey: bytesToBase64(dek), ttlSeconds }) }),
    'unlock',
  );
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

/** `b1dz unlock | lock | vault <status|passwd>` */
export async function vaultCommand(cmd: string, args: string[]): Promise<void> {
  const ctx = requireCtx();
  try {
    if (cmd === 'unlock') {
      const ttl = parseTtl(flag(args, '--ttl') ?? process.env.B1DZ_UNLOCK_TTL);
      const v = await openVault(ctx);
      if (!v) throw new Error('no vault yet: run `b1dz setup` (or set a passphrase at b1dz.com/settings)');
      const r = await unlockTrading(ctx, v.dek, ttl);
      v.dek.fill(0);
      console.log(C.green(`trading unlocked until ${r.expiresAt ?? '?'}`));
      return;
    }
    if (cmd === 'lock') {
      await json(await api(ctx, '/api/daemon/session', { method: 'DELETE' }), 'lock');
      console.log(C.yellow('trading locked: strategies paused until you unlock'));
      return;
    }
    const sub = args[0] ?? 'status';
    if (sub === 'status') {
      const s = await fetchSettings(ctx);
      const sess = await json<{ unlocked: boolean; expiresAt: string | null; reachable: boolean }>(await api(ctx, '/api/daemon/session'), 'session');
      console.log(`vault:   ${s.seal ? 'passphrase set' : s.legacy.pending ? C.yellow('legacy server-key secrets: run `b1dz setup` to migrate') : 'not set up'}`);
      console.log(`trading: ${!sess.reachable ? C.red('daemon unreachable') : sess.unlocked ? C.green(`unlocked until ${sess.expiresAt}`) : C.yellow('locked (strategies paused)')}`);
      if (s.inbox.length) console.log(C.dim(`${s.inbox.length} OAuth token update(s) waiting: unlock to apply`));
      return;
    }
    if (sub === 'passwd') {
      const v = await openVault(ctx);
      if (!v || !v.settings.seal) throw new Error('no vault yet');
      const seal = await rewrapSeal(v.dek, v.settings.seal, await newPassphrase(), v.userId);
      v.dek.fill(0);
      await putSettings(ctx, { seal });
      console.log(C.green('passphrase changed'));
      return;
    }
    throw new Error(`unknown: b1dz vault ${sub} (status|passwd)`);
  } catch (e) {
    console.error(C.red((e as Error).message));
    process.exit(1);
  }
}
