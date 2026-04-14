-- v2 opportunities queue
--
-- Durable event channel between `b1dz observe` (producer) and the v2
-- trade daemon (consumer). Table-backed queue is the simplest option
-- that satisfies PRD §11A.2 "durable internal event channel" — no new
-- infra dependencies beyond Postgres which we already run.
--
-- Observer inserts an opportunity row with status='pending'.
-- Daemon claims rows atomically (SELECT … FOR UPDATE SKIP LOCKED) and
-- transitions them through executing -> filled/rejected/failed.
-- Row retained for audit; a separate retention job truncates after 7d.

-- ----- opportunities_v2 ---------------------------------------------------
create table public.opportunities_v2 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- Claim / execution state (queue fields)
  status text not null default 'pending'
    check (status in ('pending','claimed','executing','filled','rejected','failed','expired')),
  claimed_at timestamptz,
  claimed_by text,
  resolved_at timestamptz,
  resolved_reason text,

  -- Normalized opportunity snapshot (PRD §13)
  opportunity_id text not null,
  buy_venue text not null,
  sell_venue text not null,
  buy_chain text,
  sell_chain text,
  asset text not null,
  size_usd numeric not null default 0,
  gross_edge_usd numeric not null default 0,
  total_fees_usd numeric not null default 0,
  total_gas_usd numeric not null default 0,
  total_slippage_usd numeric not null default 0,
  risk_buffer_usd numeric not null default 0,
  expected_net_usd numeric not null default 0,
  expected_net_bps numeric not null default 0,
  confidence numeric not null default 0,
  executable boolean not null default false,
  blockers text[] not null default '{}',
  category text not null,

  -- Audit: raw buy + sell quotes
  buy_quote jsonb,
  sell_quote jsonb,
  observed_at timestamptz not null default now(),

  -- Soft TTL: rows older than this shouldn't be claimed for execution.
  expires_at timestamptz not null default (now() + interval '5 seconds')
);

create index opportunities_v2_user_status_idx on public.opportunities_v2 (user_id, status, created_at desc);
create index opportunities_v2_pending_claim_idx on public.opportunities_v2 (status, expires_at) where status = 'pending';
create index opportunities_v2_user_asset_idx on public.opportunities_v2 (user_id, asset);

alter table public.opportunities_v2 enable row level security;

create policy "users see own v2 opportunities"
  on public.opportunities_v2 for select
  to authenticated using (user_id = auth.uid());
create policy "users write own v2 opportunities"
  on public.opportunities_v2 for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
