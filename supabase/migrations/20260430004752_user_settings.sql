-- user_settings: per-user configuration store.
--
-- payload_plain: non-secret fields (wallet addresses, thresholds, toggles,
-- RPC URLs). Visible to anyone with DB access. Indexed via JSONB ops if needed.
--
-- payload_secret_*: AES-256-GCM ciphertext of the secret blob (CEX/DEX API
-- keys, hot-wallet privkeys). Decrypted server-side by /api/settings using
-- SETTINGS_ENCRYPTION_KEY (service-level env var). RLS gates owner access;
-- RLS bypass via service role still cannot read plaintext without the key.

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload_plain jsonb not null default '{}'::jsonb,
  payload_secret_ciphertext text,
  payload_secret_iv text,
  payload_secret_tag text,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "user_settings select own"
  on public.user_settings for select
  to authenticated
  using (auth.uid() = user_id);

create policy "user_settings upsert own"
  on public.user_settings for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index user_settings_updated_idx on public.user_settings (updated_at desc);
