-- Sealed user keys (seal_version 2).
--
-- Before: payload_secret_* was AES-256-GCM under HMAC(SETTINGS_ENCRYPTION_KEY,
-- user_id) (or the master key itself for the oldest rows). That key lives in
-- the app env 24/7, so root on the box could read every user's wallet keys
-- and exchange secrets. That is seal_version 1 (legacy).
--
-- After: the client derives a key from the user's passphrase (PBKDF2-SHA256
-- 600k -> HKDF -> AES-256-GCM) which wraps a random data key; the data key
-- seals payload_secret_* with AAD bound to user id + field. `seal` holds only
-- salt, KDF params, wrapped keys, a key-check value and the OAuth inbox
-- public key. Nothing stored on our side opens it. See
-- packages/core/src/sealed-secrets.ts.
--
-- secret_inbox: OAuth provider tokens the server received, sealed to the
-- user's inbox public key (ECDH P-256). An unlocked client merges them into
-- payload_secret_* and removes them.
--
-- Legacy rows stay readable only through POST /api/settings/legacy-migrate
-- (one shot, gated by LEGACY_KEY_MIGRATION). Nothing here deletes them.

alter table public.user_settings
  add column if not exists seal_version smallint not null default 1,
  add column if not exists seal jsonb,
  add column if not exists secret_inbox jsonb not null default '[]'::jsonb;

comment on column public.user_settings.seal_version is
  '1 = legacy server-key ciphertext (SETTINGS_ENCRYPTION_KEY); 2 = sealed under a user-held passphrase key';
comment on column public.user_settings.seal is
  'v2 seal record: kdf params + salt, passphrase/recovery-wrapped data key, key check, OAuth inbox key pair (private half sealed). No plaintext, no server key.';
comment on column public.user_settings.secret_inbox is
  'OAuth tokens sealed to seal.inbox_public_key, pending merge by an unlocked client';

-- A v2 row must carry its seal.
alter table public.user_settings
  drop constraint if exists user_settings_seal_v2_has_seal;
alter table public.user_settings
  add constraint user_settings_seal_v2_has_seal check (seal_version <> 2 or seal is not null);

-- Unmigrated legacy rows (run by an admin before the cutoff):
--   select count(*) from public.user_settings
--    where seal_version = 1 and payload_secret_ciphertext is not null;
create or replace view public.user_settings_seal_status as
  select
    count(*) filter (where seal_version = 1 and payload_secret_ciphertext is not null) as legacy_unmigrated,
    count(*) filter (where seal_version = 2) as sealed,
    count(*) filter (where seal_version = 1 and payload_secret_ciphertext is null) as no_secrets
  from public.user_settings;

revoke all on public.user_settings_seal_status from anon, authenticated;

-- Users write their own row through PostgREST (RLS "upsert own"). Stop a
-- signed-in user from writing NEW legacy ciphertext or downgrading a sealed
-- row: otherwise the one-shot legacy migrate endpoint would become a
-- decryption oracle for ciphertext under the old server key. Service role
-- (daemon, admin scripts) is unaffected.
create or replace function public.user_settings_guard_seal()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.seal_version < old.seal_version then
    raise exception 'user_settings: cannot downgrade seal_version' using errcode = '42501';
  end if;
  if new.seal_version = 1 and new.payload_secret_ciphertext is not null
     and (tg_op = 'INSERT' or new.payload_secret_ciphertext is distinct from old.payload_secret_ciphertext) then
    raise exception 'user_settings: legacy (server-key) ciphertext is read-only; set a passphrase first' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists user_settings_guard_seal on public.user_settings;
create trigger user_settings_guard_seal
  before insert or update on public.user_settings
  for each row execute function public.user_settings_guard_seal();
