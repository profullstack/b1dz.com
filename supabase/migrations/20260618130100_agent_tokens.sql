-- Agent tokens — "Coinbase for Agents" analog. Each row is a scoped credential
-- ("sub-account") that an external AI system (Claude, ChatGPT, an MCP client)
-- presents to trade on the user's behalf, hard-capped by its own spend budget.
--
-- Only a hash of the token is stored (the plaintext is shown once at creation).
-- Per-token spend is enforced by summing crypto_spend_ledger filtered by
-- agent_token_id against budget_usd over budget_window.

create table if not exists public.agent_tokens (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  -- sha-256 hex of the plaintext token (b1dz_agent_<random>). Never store plain.
  token_hash      text not null unique,
  -- last 4 chars of the plaintext, for UI display ("…a1b2").
  token_suffix    text not null,
  scopes          text[] not null default '{read}',
  budget_usd      numeric not null default 0 check (budget_usd >= 0),
  budget_window   text not null default 'daily' check (budget_window in ('daily', 'weekly', 'monthly')),
  -- optional symbol allowlist (e.g. {BTC-USD,ETH-USD}); null/empty = any.
  allowed_symbols text[],
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists agent_tokens_user_idx on public.agent_tokens (user_id);
create unique index if not exists agent_tokens_hash_idx on public.agent_tokens (token_hash);

alter table public.agent_tokens enable row level security;

drop policy if exists "agent_tokens_owner" on public.agent_tokens;
create policy "agent_tokens_owner" on public.agent_tokens
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Audit log of every action an agent token performed (read or trade). Append-
-- only from the app; owner can read their own.
create table if not exists public.agent_actions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  agent_token_id uuid references public.agent_tokens(id) on delete set null,
  action         text not null,
  detail         jsonb,
  ok             boolean not null default true,
  ts             timestamptz not null default now()
);

create index if not exists agent_actions_user_ts_idx on public.agent_actions (user_id, ts desc);

alter table public.agent_actions enable row level security;

drop policy if exists "agent_actions_owner" on public.agent_actions;
create policy "agent_actions_owner" on public.agent_actions
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
