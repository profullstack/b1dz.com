-- Crypto spend ledger — the durable record of every BUY the platform executes
-- on a user's behalf (engine, AI analyzer, or external agent). The rolling
-- spend budget is summed from this table per window, so the cap survives daemon
-- restarts and is shared across the engine and the agent API.
--
-- RLS owner-only (the ensure_rls event trigger auto-enables RLS on new tables;
-- we add the owner policy explicitly here).

create table if not exists public.crypto_spend_ledger (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  ts            timestamptz not null default now(),
  source        text not null default 'engine' check (source in ('engine', 'ai', 'agent')),
  exchange      text,
  pair          text,
  usd           numeric not null check (usd >= 0),
  -- set when an agent token initiated the spend, so per-token budgets can be
  -- enforced by summing this column filtered by agent_token_id.
  agent_token_id uuid,
  created_at    timestamptz not null default now()
);

create index if not exists crypto_spend_ledger_user_ts_idx
  on public.crypto_spend_ledger (user_id, ts desc);
create index if not exists crypto_spend_ledger_token_ts_idx
  on public.crypto_spend_ledger (agent_token_id, ts desc)
  where agent_token_id is not null;

alter table public.crypto_spend_ledger enable row level security;

drop policy if exists "spend_ledger_owner" on public.crypto_spend_ledger;
create policy "spend_ledger_owner" on public.crypto_spend_ledger
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
