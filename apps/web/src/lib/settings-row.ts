/** Shared user_settings row helpers for the settings + migrate + oauth routes. */
import { isInboxEntry, isSealRecord, type CipherBlob, type InboxEntry, type SealRecord } from '@b1dz/core/sealed-secrets';

export interface SettingsRow {
  user_id: string;
  payload_plain: Record<string, unknown> | null;
  payload_secret_ciphertext: string | null;
  payload_secret_iv: string | null;
  payload_secret_tag: string | null;
  seal_version: number | null;
  seal: unknown;
  secret_inbox: unknown;
  updated_at: string;
}

export type Sb = {
  from: (t: string) => {
    select: (s: string) => { eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: SettingsRow | null; error: { message: string } | null }> } };
    upsert: (r: Record<string, unknown>, o: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
  };
};

export async function loadSettingsRow(client: unknown, userId: string): Promise<SettingsRow | null> {
  const { data, error } = await (client as Sb).from('user_settings').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export function rowToCipher(row: SettingsRow | null): CipherBlob | null {
  if (!row?.payload_secret_ciphertext || !row.payload_secret_iv || !row.payload_secret_tag) return null;
  return { ciphertext: row.payload_secret_ciphertext, iv: row.payload_secret_iv, tag: row.payload_secret_tag };
}

export function rowSeal(row: SettingsRow | null): SealRecord | null {
  return row && row.seal_version === 2 && isSealRecord(row.seal) ? row.seal : null;
}

export function rowInbox(row: SettingsRow | null): InboxEntry[] {
  return Array.isArray(row?.secret_inbox) ? (row!.secret_inbox as unknown[]).filter(isInboxEntry) : [];
}

