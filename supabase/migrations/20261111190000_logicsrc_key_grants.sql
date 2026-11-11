-- Keys from logicsrc (@profullstack/key-grants).
-- Created: 2026-11-11
--
--   kg_grant_requests  one row per "Get from logicsrc" click: the nonce logicsrc
--                      fetches the manifest by, the key names asked for and a
--                      per-request webhook secret (signs every delivery).
--   kg_grants          logicsrc grant id -> request + key name, active/revoked.
--
-- Never a key: delivered values are sealed to the person's vault inbox and queued
-- in user_settings.secret_inbox. Columns match @profullstack/key-grants sqlStore
-- (times are epoch milliseconds). Service role only: RLS on, no policies; every
-- read and write goes through apps/web/src/lib/logicsrc-grants.ts.

create table if not exists public.kg_grant_requests (
  nonce          text primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  scope          text,
  keys           text not null,
  webhook_secret text not null,
  next_path      text not null,
  created_at     bigint not null,
  expires_at     bigint not null
);
create index if not exists kg_grant_requests_user on public.kg_grant_requests (user_id, created_at desc);

create table if not exists public.kg_grants (
  grant_id   text primary key,
  nonce      text not null,
  user_id    uuid not null references auth.users(id) on delete cascade,
  scope      text,
  key_name   text not null,
  status     text not null check (status in ('active', 'revoked')),
  updated_at bigint not null
);
create index if not exists kg_grants_user on public.kg_grants (user_id);

alter table public.kg_grant_requests enable row level security;
alter table public.kg_grants enable row level security;
revoke all on public.kg_grant_requests from anon, authenticated;
revoke all on public.kg_grants from anon, authenticated;
grant all on public.kg_grant_requests to service_role;
grant all on public.kg_grants to service_role;
