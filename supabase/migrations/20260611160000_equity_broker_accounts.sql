-- Equities v1: broker account linking + equity position/order tracking.
--
-- Broker connectors (Alpaca, later IBKR/Tradier) are first-party plugins. The
-- user's broker credentials (OAuth tokens / API keys) continue to live in
-- user_settings.payload_secret_* (AES-256-GCM, decrypted server-side) — the
-- same encrypted store the CEX/DEX connectors use. These tables hold the
-- *non-secret* operational state the daemon and dashboard need:
--
--   user_broker_accounts — which brokers a user has linked (one row per
--     linked account; a user may hold several, e.g. paper + live or multiple
--     IBKR sub-accounts).
--   equity_positions — last-known positions per linked account, refreshed from
--     the connector's positions() call; drives the dashboard and risk math.
--   equity_orders — order lifecycle audit, mirroring BrokerOrderArgs /
--     BrokerOrderResult, tagged with the strategy that emitted the signal.
--
-- RLS gates every table to the owning user, matching user_settings /
-- user_installed_plugins.

create table public.user_broker_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null,                       -- 'alpaca' | 'ibkr' | 'tradier' | …
  markets text[] not null default '{}',        -- 'us', 'ca', 'uk', …
  label text,                                  -- user-facing nickname
  external_account_id text,                    -- broker's own account id
  is_paper boolean not null default true,      -- live execution stays gated by EQUITY_TRADE_EXECUTION
  status text not null default 'linked',       -- linked | revoked | error
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, broker, external_account_id)
);
alter table public.user_broker_accounts enable row level security;
create policy "user_broker_accounts select own"
  on public.user_broker_accounts for select
  to authenticated
  using (auth.uid() = user_id);
create policy "user_broker_accounts write own"
  on public.user_broker_accounts for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create index user_broker_accounts_user_idx on public.user_broker_accounts (user_id);

create table public.equity_positions (
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_account_id uuid not null references public.user_broker_accounts(id) on delete cascade,
  symbol text not null,                        -- 'AAPL'
  exchange text,                                -- 'NASDAQ', 'LSE', 'TSE', …
  qty numeric not null default 0,               -- fractional allowed
  avg_entry numeric not null default 0,
  market_value numeric not null default 0,
  currency text not null default 'USD',         -- non-USD marked to USD by the FX service
  as_of timestamptz not null default now(),
  primary key (broker_account_id, symbol)
);
alter table public.equity_positions enable row level security;
create policy "equity_positions select own"
  on public.equity_positions for select
  to authenticated
  using (auth.uid() = user_id);
create policy "equity_positions write own"
  on public.equity_positions for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create index equity_positions_user_idx on public.equity_positions (user_id);

create table public.equity_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_account_id uuid not null references public.user_broker_accounts(id) on delete cascade,
  broker_order_id text,                        -- id returned by the broker
  symbol text not null,
  side text not null,                          -- buy | sell
  qty numeric,                                  -- shares (fractional ok)
  notional_usd numeric,                         -- engine prefers notional when supported
  type text not null,                          -- market | limit
  limit_price numeric,
  tif text not null default 'day',             -- day | gtc | ioc
  extended_hours boolean not null default false,
  status text not null default 'accepted',     -- accepted | filled | partial | rejected | canceled
  fill_price numeric,
  filled_qty numeric,
  strategy_id text,                            -- StrategyPlugin that emitted the signal
  message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.equity_orders enable row level security;
create policy "equity_orders select own"
  on public.equity_orders for select
  to authenticated
  using (auth.uid() = user_id);
create policy "equity_orders write own"
  on public.equity_orders for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create index equity_orders_user_idx on public.equity_orders (user_id, created_at desc);
create index equity_orders_account_idx on public.equity_orders (broker_account_id, status);
create index equity_orders_broker_order_idx on public.equity_orders (broker_order_id) where broker_order_id is not null;
