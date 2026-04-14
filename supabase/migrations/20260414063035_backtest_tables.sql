-- backtest_runs + backtest_trades
--
-- Every invocation of /api/backtest produces a row in backtest_runs with
-- parameters + aggregate metrics, plus one row per simulated trade in
-- backtest_trades. Lets users review historical runs, compare tuning
-- changes, and export trade-level data for deeper analysis without
-- re-fetching candles.
--
-- Tables are prefixed backtest_* as a namespace. RLS matches the rest of
-- the schema — users only see their own runs and trades.

-- ----- backtest_runs ------------------------------------------------------
create table public.backtest_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ran_at timestamptz not null default now(),

  -- parameters
  timeframe text not null,
  exchange text not null,
  exchanges_ran text[] not null default '{}',
  pairs_requested int not null default 0,
  limit_candles int not null default 0,
  equity numeric not null default 0,
  fee_rate numeric,
  slippage_pct numeric,
  spread_pct numeric,

  -- aggregate outcomes
  total_candles int not null default 0,
  total_trades int not null default 0,
  total_net_pnl numeric not null default 0,
  total_gross_pnl numeric not null default 0,
  total_fees numeric not null default 0,
  winning_trades int not null default 0,
  losing_trades int not null default 0,
  winning_pairs int not null default 0,
  losing_pairs int not null default 0,
  total_capital_usd numeric not null default 0,
  halted_by_daily_loss_limit boolean not null default false,
  duration_ms int not null default 0,

  -- structured breakdowns (metrics + per-exchange summary)
  metrics jsonb,
  per_exchange jsonb
);

create index backtest_runs_user_ran_at_idx on public.backtest_runs (user_id, ran_at desc);
create index backtest_runs_user_timeframe_idx on public.backtest_runs (user_id, timeframe);

alter table public.backtest_runs enable row level security;

create policy "users see own backtest_runs"
  on public.backtest_runs for select
  to authenticated using (user_id = auth.uid());
create policy "users write own backtest_runs"
  on public.backtest_runs for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----- backtest_trades ----------------------------------------------------
create table public.backtest_trades (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.backtest_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  symbol text not null,
  exchange text not null,
  direction text not null,
  regime text,
  setup_type text,
  score int,

  entry_time timestamptz not null,
  exit_time timestamptz not null,
  entry_price numeric not null,
  exit_price numeric not null,
  stop_loss numeric,
  take_profit numeric,

  gross_pnl numeric not null,
  fees numeric not null,
  slippage_cost numeric not null,
  net_pnl numeric not null,

  hold_minutes numeric not null,
  hour_of_day int,
  volatility_bucket text
);

create index backtest_trades_run_idx on public.backtest_trades (run_id);
create index backtest_trades_user_entry_time_idx on public.backtest_trades (user_id, entry_time desc);
create index backtest_trades_user_symbol_idx on public.backtest_trades (user_id, symbol);

alter table public.backtest_trades enable row level security;

create policy "users see own backtest_trades"
  on public.backtest_trades for select
  to authenticated using (user_id = auth.uid());
create policy "users write own backtest_trades"
  on public.backtest_trades for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
