-- User-authored TSP strategies from the /store/build wizard.
--
-- A row is private to its author until published; published rows are listed
-- in the store under "Community strategies" and readable by anyone. The
-- backtest snapshot is written only by the publish route (server-side rerun),
-- so a listing's numbers can't be typed in by the author.
--
-- Apply by hand on the dev2 self-hosted database:
--   docker exec -i b1dz-com-supabase-db psql -U postgres -d postgres -1 < this file
--   then: notify pgrst, 'reload schema';

create table if not exists public.user_strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  definition jsonb not null,
  asset_classes text[] not null default '{}',
  visibility text not null default 'private' check (visibility in ('private', 'published')),
  author_name text,
  backtest jsonb,
  backtested_at timestamptz,
  published_at timestamptz,
  forked_from uuid references public.user_strategies(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);
create index if not exists user_strategies_user on public.user_strategies (user_id, updated_at desc);
create index if not exists user_strategies_published on public.user_strategies (published_at desc) where visibility = 'published';

alter table public.user_strategies enable row level security;
revoke all on public.user_strategies from anon, authenticated;
grant select on public.user_strategies to anon, authenticated;
grant insert, update, delete on public.user_strategies to authenticated;

drop policy if exists user_strategies_read on public.user_strategies;
create policy user_strategies_read on public.user_strategies
  for select using (visibility = 'published' or user_id = auth.uid());

drop policy if exists user_strategies_insert on public.user_strategies;
create policy user_strategies_insert on public.user_strategies
  for insert to authenticated with check (user_id = auth.uid() and visibility = 'private' and backtest is null);

drop policy if exists user_strategies_update on public.user_strategies;
create policy user_strategies_update on public.user_strategies
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists user_strategies_delete on public.user_strategies;
create policy user_strategies_delete on public.user_strategies
  for delete to authenticated using (user_id = auth.uid());

-- Authors may edit name/definition/etc. but publishing state and the backtest
-- snapshot only change through the service role (the publish route).
revoke update on public.user_strategies from authenticated;
grant update (slug, name, description, definition, asset_classes, updated_at) on public.user_strategies to authenticated;

-- Editing a published strategy's logic would leave its listed backtest stale,
-- so any definition change by the author takes it back to private.
create or replace function public.user_strategies_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.definition is distinct from old.definition and current_user <> 'service_role' then
    new.visibility := 'private';
    new.published_at := null;
    new.backtest := null;
    new.backtested_at := null;
  end if;
  return new;
end $$;

drop trigger if exists user_strategies_touch on public.user_strategies;
create trigger user_strategies_touch before update on public.user_strategies
  for each row execute function public.user_strategies_touch();
