-- strategy_registry + forward_trades
--
-- The strategy store's moat. A TSP document that passes the gauntlet is
-- registered here and graduate to forward-test (paper trading over live
-- market data). Every forward trade is recorded, and once the live track
-- record reaches MinTRL, the strategy can be listed for sale.
--
-- Tables:
--   strategy_registry — one row per (user, candidate) that survived the gauntlet
--   forward_trades    — every paper trade the forward-test daemon records
--
-- RLS: users only see their own registrations and trades. The daemon uses a
-- service-role key to poll across all users.

-- ----- strategy_registry ----------------------------------------------------
create table public.strategy_registry (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_id text not null,
  tsp_doc jsonb not null,
  compiled boolean not null default true,
  status text not null default 'gauntlet_passed'
    check (status in ('gauntlet_passed','forward_running','min_trl_reached','listed','rejected','archived')),
  gauntlet_report jsonb not null default '{}',
  cost_model jsonb not null,
  listed_at timestamptz,
  rejected_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index strategy_registry_user_candidate_idx
  on public.strategy_registry (user_id, candidate_id);

create index strategy_registry_user_id_idx
  on public.strategy_registry (user_id);

create index strategy_registry_status_idx
  on public.strategy_registry (status);

alter table public.strategy_registry enable row level security;

create policy "users see own strategy_registrations"
  on public.strategy_registry for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----- forward_trades -------------------------------------------------------
create table public.forward_trades (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategy_registry(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_ts timestamptz not null,
  exit_ts timestamptz,
  entered_at timestamptz not null default now(),
  closed_at timestamptz,
  trade_json jsonb not null,
  regime_at_entry text,
  recorded_at timestamptz not null default now()
);

create index forward_trades_strategy_id_idx
  on public.forward_trades (strategy_id);

create index forward_trades_user_id_idx
  on public.forward_trades (user_id);

create index forward_trades_strategy_open_idx
  on public.forward_trades (strategy_id) where exit_ts is null;

alter table public.forward_trades enable row level security;

create policy "users see own forward_trades"
  on public.forward_trades for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
