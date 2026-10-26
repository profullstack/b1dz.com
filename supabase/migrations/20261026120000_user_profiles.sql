-- The shared @profullstack/profile fields (email, first_name, last_name,
-- company_domain, job_title, linkedin_url), keyed by the auth user id.
-- b1dz has no public users table, so this is the package's own table.
-- Generated with `profile schema --key user_id --key-type uuid`.
--
-- RLS is on with NO anon/authenticated policies: only the server's
-- service-role client (src/lib/profile.ts) reads or writes it.
--
-- Apply by hand on the dev2 self-hosted database:
--   docker exec -i b1dz-com-supabase-db psql -U postgres -d postgres -1 < this file
--   then: notify pgrst, 'reload schema';

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  first_name text,
  last_name text,
  company_domain text,
  job_title text,
  linkedin_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists user_profiles_email on public.user_profiles (lower(email));
create index if not exists user_profiles_company_domain on public.user_profiles (company_domain);

alter table public.user_profiles enable row level security;
revoke all on public.user_profiles from anon, authenticated;
