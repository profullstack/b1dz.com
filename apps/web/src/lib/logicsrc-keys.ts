/**
 * Which b1dz secrets can be requested from logicsrc (client-safe: no server imports).
 *
 * Every SECRET_FIELDS entry except signing material: wallet private keys,
 * seeds, mnemonics and exchange signing keys (Coinbase's EC/private key) never
 * leave the person's own hands. logicsrc refuses to grant those anyway; b1dz
 * refuses to ask.
 */
import { SECRET_FIELDS } from '@b1dz/core/settings-fields';

const SIGNING = /PRIVATE|SEED|MNEMONIC|EC_KEY/i;

export const LOGICSRC_GRANTABLE_KEYS: readonly string[] = SECRET_FIELDS.filter((k) => !SIGNING.test(k));

export const DEFAULT_LOGICSRC_KEYS = ['ANTHROPIC_API_KEY'];

export function isGrantableKey(name: string): boolean {
  return LOGICSRC_GRANTABLE_KEYS.includes(name);
}

/** Copy for ?logicsrc=<code> on return to /settings. */
export function logicsrcNotice(code: string): { ok: boolean; text: string } {
  switch (code) {
    case 'granted':
      return { ok: true, text: 'Approved on logicsrc. The key arrives sealed to your vault; unlock your vault to apply it.' };
    case 'needs_vault':
      return { ok: false, text: 'Set a vault passphrase first: keys from logicsrc are sealed to your vault.' };
    case 'no_keys':
      return { ok: false, text: 'Pick at least one key to request from logicsrc.' };
    case 'bad_key':
      return { ok: false, text: 'b1dz can only request API keys from logicsrc, never wallet or signing keys.' };
    case 'too_many':
      return { ok: false, text: 'Request at most 20 keys at a time from logicsrc.' };
    case 'signed_out':
      return { ok: false, text: 'Sign in first, then request keys from logicsrc.' };
    default:
      return { ok: false, text: `The logicsrc request did not complete (${code}).` };
  }
}
