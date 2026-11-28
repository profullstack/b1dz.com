-- Passkeys (WebAuthn) for b1dz sign-in. Additive only.
--
-- A passkey is added from Settings while signed in, and afterwards signs in to
-- that account with no email or password: the server verifies the assertion
-- with @simplewebauthn/server and then starts a normal Supabase session for
-- the credential's owner (lib/passkeys.ts). Server code (service role) is the
-- only reader and writer of both tables.

create table if not exists public.passkeys (
  -- WebAuthn credential id, base64url.
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- COSE public key, base64url.
  public_key text not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  device_type text not null default 'singleDevice' check (device_type in ('singleDevice', 'multiDevice')),
  backed_up boolean not null default false,
  aaguid text,
  name text not null default 'Passkey',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists passkeys_user_id_idx on public.passkeys(user_id);
alter table public.passkeys enable row level security;
revoke all on table public.passkeys from anon, authenticated;

-- One row per ceremony; consumed (deleted) by the verify step, so a challenge
-- is good for exactly one attempt. The browser holds only the row id, in an
-- httpOnly cookie.
create table if not exists public.passkey_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge text not null,
  purpose text not null check (purpose in ('register', 'login')),
  -- Set for 'register': the account the passkey is being added to.
  user_id uuid references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '5 minutes'
);
create index if not exists passkey_challenges_expires_idx on public.passkey_challenges(expires_at);
alter table public.passkey_challenges enable row level security;
revoke all on table public.passkey_challenges from anon, authenticated;
