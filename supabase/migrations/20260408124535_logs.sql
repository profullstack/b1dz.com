-- Logs table — append-only event log for every source.
--
-- Replaces the .dd.log file as the canonical history. We still write a
-- rolling local file in dev for grep/tail convenience, but the DB is the
-- system of record (queryable from the dashboard, retained forever).

create table if not exists public.logs (
  id          bigserial primary key,
  source_id   text,                  -- nullable for cross-cutting events
  level       text not null check (level in ('debug','info','warn','error')),
  message     text not null,
  context     jsonb,                 -- structured fields (auctionId, etc.)
  at          timestamptz not null default now()
);

create index if not exists logs_at_idx on public.logs (at desc);
create index if not exists logs_source_idx on public.logs (source_id);
create index if not exists logs_level_idx on public.logs (level);
-- Composite index for the typical "tail by source" query pattern
create index if not exists logs_source_at_idx on public.logs (source_id, at desc);

alter table public.logs enable row level security;

create policy "auth can read logs"
  on public.logs for select
  to authenticated using (true);
create policy "auth can write logs"
  on public.logs for insert
  to authenticated with check (true);

-- Realtime so the dashboard can tail in real time
alter publication supabase_realtime add table public.logs;
