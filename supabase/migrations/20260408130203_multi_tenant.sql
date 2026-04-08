-- Multi-tenancy: every table gains a user_id pointing at auth.users.
--
-- Tables are empty at this point, so we add user_id NOT NULL directly with
-- no backfill. RLS policies are rewritten to filter by auth.uid() so each
-- user only sees their own rows.
--
-- source_state's primary key changes from (source_id) to (user_id, source_id)
-- so multiple users can each maintain their own scratchpad per source.

-- ----- opportunities ------------------------------------------------------
alter table public.opportunities add column user_id uuid not null
  references auth.users(id) on delete cascade;
create index if not exists opportunities_user_idx on public.opportunities (user_id);
create index if not exists opportunities_user_source_idx on public.opportunities (user_id, source_id);
create index if not exists opportunities_user_updated_idx on public.opportunities (user_id, updated_at desc);

drop policy if exists "auth can read opportunities" on public.opportunities;
drop policy if exists "auth can write opportunities" on public.opportunities;
create policy "users see own opportunities"
  on public.opportunities for select
  to authenticated using (user_id = auth.uid());
create policy "users write own opportunities"
  on public.opportunities for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----- alerts -------------------------------------------------------------
alter table public.alerts add column user_id uuid not null
  references auth.users(id) on delete cascade;
create index if not exists alerts_user_idx on public.alerts (user_id);
create index if not exists alerts_user_at_idx on public.alerts (user_id, at desc);

drop policy if exists "auth can read alerts" on public.alerts;
drop policy if exists "auth can write alerts" on public.alerts;
create policy "users see own alerts"
  on public.alerts for select
  to authenticated using (user_id = auth.uid());
create policy "users write own alerts"
  on public.alerts for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----- source_state -------------------------------------------------------
-- Promote PK to (user_id, source_id) so each user has their own per-source
-- scratchpad. We drop the old single-column PK first.
alter table public.source_state add column user_id uuid not null
  references auth.users(id) on delete cascade;
alter table public.source_state drop constraint source_state_pkey;
alter table public.source_state add constraint source_state_pkey
  primary key (user_id, source_id);

drop policy if exists "auth can read source_state" on public.source_state;
drop policy if exists "auth can write source_state" on public.source_state;
create policy "users see own source_state"
  on public.source_state for select
  to authenticated using (user_id = auth.uid());
create policy "users write own source_state"
  on public.source_state for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----- logs ---------------------------------------------------------------
-- Logs are per-user too. Nullable for cross-cutting system events.
alter table public.logs add column user_id uuid
  references auth.users(id) on delete cascade;
create index if not exists logs_user_idx on public.logs (user_id);
create index if not exists logs_user_at_idx on public.logs (user_id, at desc);

drop policy if exists "auth can read logs" on public.logs;
drop policy if exists "auth can write logs" on public.logs;
create policy "users see own logs"
  on public.logs for select
  to authenticated using (user_id = auth.uid() or user_id is null);
create policy "users write own logs"
  on public.logs for insert
  to authenticated with check (user_id = auth.uid() or user_id is null);
