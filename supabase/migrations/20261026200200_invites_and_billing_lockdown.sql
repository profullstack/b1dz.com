-- Credit codes + invites (b1dz), and closing the self-service billing holes.
--
-- Apply by hand on the dev2 self-hosted database, after
-- 20261026200000_redeem_credits.sql and 20261026200100_affiliates.sql:
--   docker exec -i b1dz-com-supabase-db psql -U postgres -d postgres -1 < this file
--   then: notify pgrst, 'reload schema';

-- ── Invite bonus bookkeeping ───────────────────────────────────────────────
-- One row per (invite, side): what the bonus check decided and why. Pending
-- rows are re-checked later (email confirmation, the next visit to /invites);
-- 'granted' is final. Service role only.
create table if not exists public.invite_bonuses (
  invite_id text not null,
  side text not null check (side in ('inviter', 'invitee')),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('pending', 'granted', 'denied')),
  reason text,
  days integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (invite_id, side)
);
create index if not exists invite_bonuses_user on public.invite_bonuses (user_id, status, updated_at desc);
alter table public.invite_bonuses enable row level security;
revoke all on public.invite_bonuses from anon, authenticated;
grant select, insert, update, delete on public.invite_bonuses to service_role;

-- Where each side of an invite connected from, as a salted hash of the
-- address nginx saw (X-Real-IP, set from the TCP peer, never a header the
-- client sends). Used only to hold a bonus when both sides share a network.
create table if not exists public.invite_network (
  invite_id text primary key,
  inviter_ip_hash text,
  invitee_ip_hash text,
  created_at timestamptz not null default now()
);
alter table public.invite_network enable row level security;
revoke all on public.invite_network from anon, authenticated;
grant select, insert, update, delete on public.invite_network to service_role;

-- A bonus grant lands in credit_ledger once per (user, invite side), even if
-- two settle calls race: the second insert fails on this index.
create unique index if not exists credit_ledger_invite_grant_once
  on public.credit_ledger (user_id, source) where source like 'invite:%';

-- ── Billing lockdown (rule: users never write their own paid state) ────────
-- user_installed_plugins.paid_until is the paid gate for subscription
-- plugins, and plugin_invoices.paid_at/status record payment. Both had
-- "write own" policies for authenticated, so any signed-in user could PATCH
-- paid_until into the future or mark an invoice paid through PostgREST.
-- Every write now goes through the server's service-role client, which
-- checks the catalog price first. Users keep read access to their own rows.
drop policy if exists "user installed plugins write own" on public.user_installed_plugins;
drop policy if exists "plugin_invoices write own" on public.plugin_invoices;
revoke insert, update, delete, truncate on public.user_installed_plugins from anon, authenticated;
revoke insert, update, delete, truncate on public.plugin_invoices from anon, authenticated;
revoke all on public.user_installed_plugins from anon;
revoke all on public.plugin_invoices from anon;

-- 20260612120000 never reached the dev2 database: anon and authenticated
-- could still execute this SECURITY DEFINER event-trigger function.
revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.rls_auto_enable() from anon;
revoke execute on function public.rls_auto_enable() from authenticated;
