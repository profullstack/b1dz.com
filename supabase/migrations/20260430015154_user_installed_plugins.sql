-- Phase C: per-user plugin install gating + Coinpay invoices.
--
-- user_installed_plugins is the gate the daemon checks before scheduling
-- a paid plugin's source. Free plugins also land here on install (paid_until
-- = null = never expires) so the UI can show "Installed" badges uniformly.
--
-- plugin_invoices tracks every Coinpay payment the user kicked off — one
-- row per invoice, status flips through pending → detected → confirmed →
-- forwarded as Coinpay's webhook fires. The invoice page polls the row.

create table public.user_installed_plugins (
  user_id uuid not null references auth.users(id) on delete cascade,
  plugin_id text not null,
  version text not null,
  status text not null default 'active', -- active | expired | cancelled
  paid_until timestamptz,                 -- null = free plugin (no expiry)
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, plugin_id)
);
alter table public.user_installed_plugins enable row level security;
create policy "user installed plugins select own"
  on public.user_installed_plugins for select
  to authenticated
  using (auth.uid() = user_id);
create policy "user installed plugins write own"
  on public.user_installed_plugins for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create index user_installed_plugins_user_idx on public.user_installed_plugins (user_id);
create index user_installed_plugins_paid_until_idx on public.user_installed_plugins (paid_until) where paid_until is not null;

create table public.plugin_invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plugin_id text not null,
  coinpay_payment_id text,           -- pay_xxx from coinpay
  amount_usd numeric(10,2) not null,
  blockchain text not null,
  payment_address text,
  crypto_amount text,                 -- string because crypto numbers
  qr_code text,                       -- data URL or null
  status text not null default 'pending', -- pending | detected | confirmed | forwarded | expired | failed
  expires_at timestamptz,             -- coinpay's expires_at
  paid_at timestamptz,
  forwarded_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.plugin_invoices enable row level security;
create policy "plugin_invoices select own"
  on public.plugin_invoices for select
  to authenticated
  using (auth.uid() = user_id);
create policy "plugin_invoices write own"
  on public.plugin_invoices for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create index plugin_invoices_user_idx on public.plugin_invoices (user_id);
create index plugin_invoices_coinpay_payment_idx on public.plugin_invoices (coinpay_payment_id);
create index plugin_invoices_status_idx on public.plugin_invoices (status, created_at desc);
