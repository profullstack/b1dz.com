-- b1dz monetization (plan approved 2026-11-25, a 60-day test to 2027-01-24).
--
-- Apply by hand on dev2 (take a pg_dump first):
--   docker exec -i b1dz-com-supabase-db psql -U postgres -d postgres -1 < this file
--   then: notify pgrst, 'reload schema';
--
-- Every table here is service-role only: RLS on, no policies, anon and
-- authenticated get nothing. Users never write their own paid state.

-- ── AI analyst usage ───────────────────────────────────────────────────────
-- One row per Anthropic call made for a user (or an anonymous x402 agent),
-- with the tokens and cost read from the API's usage block. The Pro cap
-- ($8/month by default) and the free allowance (5/day, monthly cost cap)
-- are sums over this table.
create table if not exists public.ai_usage (
  id              bigserial primary key,
  user_id         uuid references auth.users(id) on delete cascade,
  at              timestamptz not null default now(),
  kind            text not null default 'analyst',
  tier            text not null check (tier in ('pro', 'free', 'agent')),
  model           text,
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  cost_usd        numeric(12, 6) not null default 0,
  agent_token_id  uuid
);
create index if not exists ai_usage_user_at on public.ai_usage (user_id, at desc);
create index if not exists ai_usage_at on public.ai_usage (at desc);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;
revoke all on sequence public.ai_usage_id_seq from anon, authenticated;
grant select, insert, update, delete on public.ai_usage to service_role;
grant usage, select on sequence public.ai_usage_id_seq to service_role;

-- ── Agent charges ──────────────────────────────────────────────────────────
-- Every paid agent call: a metered research card ($0.03) or an analyst query
-- ($0.35), paid by x402 (USDC settled by CoinPay) or from the owner's prepaid
-- balance (credit_ledger unit agent_cents). x402_nonce is the proof's
-- single-use nonce: unique, so one proof is never counted twice, and a proof
-- whose call failed after settlement can be retried once (delivered=false).
create table if not exists public.agent_charges (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  user_id         uuid references auth.users(id) on delete set null,
  agent_token_id  uuid,
  resource        text not null,
  method          text not null check (method in ('x402', 'prepaid')),
  amount_usd      numeric(10, 4) not null check (amount_usd >= 0),
  delivered       boolean not null default false,
  x402_nonce      text unique,
  x402_tx         text,
  payer           text,
  network         text
);
create index if not exists agent_charges_at on public.agent_charges (at desc);
create index if not exists agent_charges_user on public.agent_charges (user_id, at desc);
alter table public.agent_charges enable row level security;
revoke all on public.agent_charges from anon, authenticated;
revoke all on sequence public.agent_charges_id_seq from anon, authenticated;
grant select, insert, update, delete on public.agent_charges to service_role;
grant usage, select on sequence public.agent_charges_id_seq to service_role;

-- ── Pro passes and agent credit bought through CoinPay ─────────────────────
-- Settled by the existing plugin_invoices path (plugin_id 'b1dz:pro-30',
-- 'b1dz:pro-365', 'b1dz:agent-credit-*'); the grant lands in credit_ledger
-- with source 'coinpay:<invoice id>', at most once per user and invoice even
-- if the webhook and the invoice poller race.
create unique index if not exists credit_ledger_coinpay_grant_once
  on public.credit_ledger (user_id, source) where source like 'coinpay:%';

-- ── Profullstack Pass, read from CoinPay userinfo at sign-in / connect ─────
alter table public.coinpay_identities add column if not exists pass_active boolean not null default false;
alter table public.coinpay_identities add column if not exists pass_expires_at timestamptz;
alter table public.coinpay_identities add column if not exists pass_checked_at timestamptz;

-- ── Founder-time note for the 60-day test (admin page) ─────────────────────
create table if not exists public.monetization_notes (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid references auth.users(id) on delete set null,
  note       text not null check (length(note) between 1 and 2000)
);
alter table public.monetization_notes enable row level security;
revoke all on public.monetization_notes from anon, authenticated;
revoke all on sequence public.monetization_notes_id_seq from anon, authenticated;
grant select, insert, update, delete on public.monetization_notes to service_role;
grant usage, select on sequence public.monetization_notes_id_seq to service_role;
