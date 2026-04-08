-- b1dz initial schema
--
-- Three tables mirror the @b1dz/core Storage collections:
--   opportunities  scored profit signals from any source
--   alerts         user-facing events (won, lost, error, threshold hit)
--   source_state   per-source persisted scratchpad (cursors, config)
--
-- Strategy: keep the full normalized record in `payload` jsonb so the
-- storage layer doesn't need to know each source's schema. Denormalize
-- only the fields we need to filter/sort on (source_id, level, timestamps).

create extension if not exists "pgcrypto";

-- ----- opportunities ------------------------------------------------------
create table if not exists public.opportunities (
  id            text primary key,                 -- '${source_id}:${external_id}'
  source_id     text not null,
  payload       jsonb not null,
  updated_at    timestamptz not null default now()
);

create index if not exists opportunities_source_idx on public.opportunities (source_id);
create index if not exists opportunities_updated_idx on public.opportunities (updated_at desc);

-- ----- alerts -------------------------------------------------------------
create table if not exists public.alerts (
  id            text primary key,                 -- '${source_id}:${ts}:${rand}'
  source_id     text not null,
  level         text not null check (level in ('good','warn','bad','info')),
  payload       jsonb not null,
  at            timestamptz not null default now()
);

create index if not exists alerts_source_idx on public.alerts (source_id);
create index if not exists alerts_at_idx on public.alerts (at desc);
create index if not exists alerts_level_idx on public.alerts (level);

-- ----- source_state -------------------------------------------------------
create table if not exists public.source_state (
  source_id     text primary key,
  payload       jsonb not null,
  updated_at    timestamptz not null default now()
);

-- ----- realtime -----------------------------------------------------------
-- Enable Supabase Realtime on alerts so PWAs / dashboards can push notify.
alter publication supabase_realtime add table public.alerts;
alter publication supabase_realtime add table public.opportunities;

-- ----- row level security -------------------------------------------------
-- Single-tenant for now: deny anonymous, allow authenticated full access.
-- Will be tightened to per-user filters when auth lands.
alter table public.opportunities enable row level security;
alter table public.alerts        enable row level security;
alter table public.source_state  enable row level security;

create policy "auth can read opportunities"
  on public.opportunities for select
  to authenticated using (true);
create policy "auth can write opportunities"
  on public.opportunities for all
  to authenticated using (true) with check (true);

create policy "auth can read alerts"
  on public.alerts for select
  to authenticated using (true);
create policy "auth can write alerts"
  on public.alerts for all
  to authenticated using (true) with check (true);

create policy "auth can read source_state"
  on public.source_state for select
  to authenticated using (true);
create policy "auth can write source_state"
  on public.source_state for all
  to authenticated using (true) with check (true);
